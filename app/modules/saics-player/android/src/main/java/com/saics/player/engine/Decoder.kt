package com.saics.player.engine

import android.content.Context
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import java.nio.ByteOrder

/**
 * Decodes a whole song (MediaExtractor + MediaCodec) into a [Pcm] at [ENGINE_RATE], stereo.
 * Mono is duplicated, extra channels dropped, other rates resampled (D15), and the encoder
 * delay (MP3 LAME / AAC priming, when the extractor reports it) trimmed. The [Pcm] is
 * returned as soon as decoding starts; playback may begin while the rest is decoded.
 */
object Decoder {
  fun open(context: Context, uri: Uri): Pair<Pcm, () -> Unit>? {
    val ex = MediaExtractor()
    try {
      ex.setDataSource(context, uri, null)
    } catch (e: Exception) {
      ex.release()
      return null
    }
    val track = (0 until ex.trackCount).firstOrNull {
      ex.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
    }
    if (track == null) {
      ex.release()
      return null
    }
    ex.selectTrack(track)
    val format = ex.getTrackFormat(track)
    val durationS = if (format.containsKey(MediaFormat.KEY_DURATION)) format.getLong(MediaFormat.KEY_DURATION) / 1e6 else 600.0
    val pcm = try {
      Pcm.forSeconds(durationS)
    } catch (e: OutOfMemoryError) {
      ex.release()
      return null
    }
    return pcm to { run(ex, format, pcm) }
  }

  private fun run(ex: MediaExtractor, format: MediaFormat, pcm: Pcm) {
    val mime = format.getString(MediaFormat.KEY_MIME)!!
    var codec: MediaCodec? = null
    try {
      codec = MediaCodec.createDecoderByType(mime)
      codec.configure(format, null, null, 0)
      codec.start()
      var skip = if (format.containsKey(MediaFormat.KEY_ENCODER_DELAY)) format.getInteger(MediaFormat.KEY_ENCODER_DELAY) else 0
      var channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
      var rate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
      var floatPcm = false
      var resampler: Resampler? = if (rate != ENGINE_RATE) Resampler(rate) else null
      val info = MediaCodec.BufferInfo()
      var inputDone = false
      var full = false
      while (!pcm.cancelled && !full) {
        if (!inputDone) {
          val i = codec.dequeueInputBuffer(5000)
          if (i >= 0) {
            val b = codec.getInputBuffer(i)!!
            val n = ex.readSampleData(b, 0)
            if (n < 0) {
              codec.queueInputBuffer(i, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              inputDone = true
            } else {
              codec.queueInputBuffer(i, 0, n, ex.sampleTime, 0)
              ex.advance()
            }
          }
        }
        val o = codec.dequeueOutputBuffer(info, 5000)
        if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
          val f = codec.outputFormat
          channels = f.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
          val newRate = f.getInteger(MediaFormat.KEY_SAMPLE_RATE)
          if (newRate != rate) {
            rate = newRate
            resampler = if (rate != ENGINE_RATE) Resampler(rate) else null
          }
          floatPcm = f.containsKey(MediaFormat.KEY_PCM_ENCODING) &&
            f.getInteger(MediaFormat.KEY_PCM_ENCODING) == AudioFormat.ENCODING_PCM_FLOAT
        } else if (o >= 0) {
          val b = codec.getOutputBuffer(o)!!.order(ByteOrder.nativeOrder())
          b.position(info.offset)
          b.limit(info.offset + info.size)
          val bytesPer = if (floatPcm) 4 else 2
          val frames = info.size / (bytesPer * channels)
          val fb = if (floatPcm) b.slice().order(ByteOrder.nativeOrder()).asFloatBuffer() else null
          for (f in 0 until frames) {
            var l: Float
            var r: Float
            if (fb != null) {
              l = fb.get(f * channels)
              r = if (channels > 1) fb.get(f * channels + 1) else l
            } else {
              val base = info.offset + f * channels * 2
              l = b.getShort(base) / 32768f
              r = if (channels > 1) b.getShort(base + 2) / 32768f else l
            }
            if (skip > 0) {
              skip--
              continue
            }
            val ok = resampler?.push(l, r, pcm) ?: pcm.put(l, r)
            if (!ok) {
              full = true
              break
            }
          }
          codec.releaseOutputBuffer(o, false)
          if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
        }
      }
      pcm.failed = pcm.frames == 0 && !pcm.cancelled // opened, but no audio came out
      pcm.complete = true
    } catch (e: Exception) {
      pcm.failed = pcm.frames == 0
      pcm.complete = true
    } finally {
      try {
        codec?.stop()
      } catch (_: Exception) {
      }
      codec?.release()
      ex.release()
    }
  }
}
