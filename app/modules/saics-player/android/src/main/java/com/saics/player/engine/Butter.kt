package com.saics.player.engine

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.tan

/**
 * Butterworth filter design matching scipy.signal.butter(N, Wn, btype, output="sos")
 * (buttap -> lp2lp/lp2hp/lp2bp -> bilinear -> second-order sections), so the live chains
 * use the same transfer functions as engine/saics/versions.py (hard rule 5).
 */
object Butter {
  private data class C(val re: Double, val im: Double) {
    operator fun plus(o: C) = C(re + o.re, im + o.im)
    operator fun minus(o: C) = C(re - o.re, im - o.im)
    operator fun times(o: C) = C(re * o.re - im * o.im, re * o.im + im * o.re)
    operator fun times(s: Double) = C(re * s, im * s)
    operator fun div(o: C): C {
      val d = o.re * o.re + o.im * o.im
      return C((re * o.re + im * o.im) / d, (im * o.re - re * o.im) / d)
    }
    fun sqrt(): C {
      val r = kotlin.math.sqrt(kotlin.math.hypot(re, im))
      val th = kotlin.math.atan2(im, re) / 2
      return C(r * cos(th), r * sin(th))
    }
  }

  /** Sections as rows [b0, b1, b2, a0=1, a1, a2]. `wn` in Hz; `sr` the sample rate. */
  fun sos(order: Int, wn: DoubleArray, type: String, sr: Double): Array<DoubleArray> {
    val nyq = sr / 2
    val fs = 2.0
    val warped = wn.map { 2 * fs * tan(PI * (it / nyq) / fs) }
    // Analog prototype: p = -exp(j*pi*m/(2N)), m = -N+1, -N+3, ..., N-1
    val proto = (0 until order).map { i ->
      val m = -order + 1 + 2 * i
      val a = PI * m / (2 * order)
      C(-cos(a), -sin(a))
    }
    var z = mutableListOf<C>()
    var p: List<C>
    var k = 1.0
    when (type) {
      "low" -> {
        val wo = warped[0]
        p = proto.map { it * wo }
        k = Math.pow(wo, order.toDouble())
      }
      "high" -> {
        val wo = warped[0]
        p = proto.map { C(wo, 0.0) / it }
        repeat(order) { z.add(C(0.0, 0.0)) }
        // k * real(prod(-z) / prod(-p)) with no prototype zeros: 1 / real(prod(-p))
        var prod = C(1.0, 0.0)
        proto.forEach { prod *= (it * -1.0) }
        k = (C(1.0, 0.0) / prod).re
      }
      "band" -> {
        val bw = warped[1] - warped[0]
        val wo = sqrt(warped[0] * warped[1])
        val pl = proto.map { it * (bw / 2) }
        p = pl.map { it + (it * it - C(wo * wo, 0.0)).sqrt() } + pl.map { it - (it * it - C(wo * wo, 0.0)).sqrt() }
        repeat(order) { z.add(C(0.0, 0.0)) }
        k = Math.pow(bw, order.toDouble())
      }
      else -> throw IllegalArgumentException(type)
    }
    // Bilinear transform (fs = 2, as scipy uses for normalised frequencies).
    val fs2 = 2 * fs
    val degree = p.size - z.size
    var num = C(1.0, 0.0)
    var den = C(1.0, 0.0)
    z.forEach { num *= (C(fs2, 0.0) - it) }
    p.forEach { den *= (C(fs2, 0.0) - it) }
    k *= (num / den).re
    val zz = z.map { (C(fs2, 0.0) + it) / (C(fs2, 0.0) - it) }.toMutableList()
    repeat(degree) { zz.add(C(-1.0, 0.0)) }
    val pz = p.map { (C(fs2, 0.0) + it) / (C(fs2, 0.0) - it) }
    return toSos(zz, pz, k)
  }

  /** Pairs conjugate poles into sections (zeros here are all real: +1 / -1). */
  private fun toSos(zeros: List<C>, poles: List<C>, k: Double): Array<DoubleArray> {
    val eps = 1e-9
    val cpx = poles.filter { it.im > eps }.sortedBy { abs(1 - kotlin.math.hypot(it.re, it.im)) }.reversed()
    val real = poles.filter { abs(it.im) <= eps }.map { it.re }.toMutableList()
    val rz = zeros.map { it.re }.toMutableList()
    val sections = mutableListOf<DoubleArray>()
    fun numerator(): DoubleArray {
      val a = rz.removeFirstOrNull()
      val b = rz.removeFirstOrNull()
      return when {
        a != null && b != null -> doubleArrayOf(1.0, -(a + b), a * b)
        a != null -> doubleArrayOf(1.0, -a, 0.0)
        else -> doubleArrayOf(1.0, 0.0, 0.0)
      }
    }
    for (pc in cpx) {
      val n = numerator()
      sections.add(doubleArrayOf(n[0], n[1], n[2], 1.0, -2 * pc.re, pc.re * pc.re + pc.im * pc.im))
    }
    while (real.isNotEmpty()) {
      val a = real.removeAt(0)
      val b = real.removeFirstOrNull()
      val n = numerator()
      sections.add(
        if (b != null) doubleArrayOf(n[0], n[1], n[2], 1.0, -(a + b), a * b)
        else doubleArrayOf(n[0], n[1], n[2], 1.0, -a, 0.0),
      )
    }
    for (i in 0 until 3) sections[0][i] *= k
    return sections.toTypedArray()
  }
}

/** A cascade of second-order sections, transposed direct form II (as scipy's sosfilt). */
class Sos(private val s: Array<DoubleArray>) {
  private val z1 = DoubleArray(s.size)
  private val z2 = DoubleArray(s.size)

  fun process(x: Double): Double {
    var v = x
    for (i in s.indices) {
      val c = s[i]
      val y = c[0] * v + z1[i]
      z1[i] = c[1] * v - c[4] * y + z2[i]
      z2[i] = c[2] * v - c[5] * y
      v = y
    }
    return v
  }

  fun reset() {
    z1.fill(0.0)
    z2.fill(0.0)
  }
}
