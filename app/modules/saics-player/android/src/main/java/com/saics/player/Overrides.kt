package com.saics.player

import android.content.ContentResolver
import android.net.Uri
import android.provider.DocumentsContract

/**
 * The owner's overrides in `.saics/` (the only place the app writes, hard rule 3), in the same
 * format the PC engine reads: `groups_overrides.csv` (saics.triage) and `forever_overrides.csv`
 * (saics.analysis). Copy them back to the PC with `adb pull` to keep both sides in step.
 */
class Overrides(
  val notLoopable: Set<String> = emptySet(),
  private val groups: List<List<String>> = emptyList(), // action, file, value
) {
  /** Replays merge/split rows over the scanned library. */
  fun applyGroups(tracks: List<Track>): List<Track> {
    var out = tracks
    for (row in groups) {
      val action = row.getOrNull(0) ?: continue
      val file = row.getOrNull(1) ?: continue
      when (action) {
        "split" -> out = out.map { if (it.file == file) it.copy(group = "split:$file", groupName = it.title) else it }
        "merge" -> {
          val target = out.firstOrNull { it.file == row.getOrNull(2) } ?: continue
          out = out.map { if (it.file == file) it.copy(group = target.group, groupName = target.groupName) else it }
        }
      }
    }
    return out
  }

  companion object {
    private const val GROUPS = "groups_overrides.csv"
    private const val FOREVER = "forever_overrides.csv"

    private fun child(cr: ContentResolver, tree: Uri, parent: String, name: String): Uri? {
      val uri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parent)
      val cols = arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME)
      cr.query(uri, cols, null, null, null)?.use { c ->
        while (c.moveToNext()) {
          if (c.getString(1) == name) return DocumentsContract.buildDocumentUriUsingTree(tree, c.getString(0))
        }
      }
      return null
    }

    private fun readLines(cr: ContentResolver, tree: Uri, saics: String, name: String): List<String> = try {
      child(cr, tree, saics, name)?.let { u ->
        cr.openInputStream(u)?.bufferedReader()?.use { it.readLines() }
      } ?: emptyList()
    } catch (e: Exception) {
      emptyList()
    }

    private fun write(cr: ContentResolver, tree: Uri, saics: String, name: String, text: String, append: Boolean): Boolean = try {
      val parent = DocumentsContract.buildDocumentUriUsingTree(tree, saics)
      val target = child(cr, tree, saics, name) ?: DocumentsContract.createDocument(cr, parent, "text/csv", name)
      target != null && cr.openOutputStream(target, if (append) "wa" else "wt")?.use { it.write(text.toByteArray()); true } == true
    } catch (e: Exception) {
      false
    }

    fun read(cr: ContentResolver, tree: Uri, saics: String): Overrides {
      val forever = readLines(cr, tree, saics, FOREVER).filter { !it.startsWith("#") }.mapNotNull { line ->
        val i = line.indexOf(',') // the file name may contain commas: only the first one separates
        if (i > 0 && line.substring(0, i).trim().lowercase() == "not_loopable") line.substring(i + 1).trim().replace('\\', '/') else null
      }.toSet()
      val groups = readLines(cr, tree, saics, GROUPS).filter { !it.startsWith("#") && it.isNotBlank() }.map { parseCsv(it) }
      return Overrides(forever, groups)
    }

    fun setNotLoopable(cr: ContentResolver, tree: Uri, saics: String?, file: String, value: Boolean): Boolean {
      saics ?: return false
      val kept = readLines(cr, tree, saics, FOREVER).filter { it.substringAfter(',', "").trim() != file }
      val lines = if (value) kept + "not_loopable,$file" else kept
      return write(cr, tree, saics, FOREVER, lines.joinToString("\n", postfix = "\n"), append = false)
    }

    fun appendGroups(cr: ContentResolver, tree: Uri, saics: String?, rows: List<List<String>>): Boolean {
      saics ?: return false
      return write(cr, tree, saics, GROUPS, rows.joinToString("") { r -> r.joinToString(",") { quote(it) } + "\n" }, append = true)
    }

    private fun quote(v: String) = if (v.any { it == ',' || it == '"' }) "\"" + v.replace("\"", "\"\"") + "\"" else v

    fun parseCsv(line: String): List<String> {
      val out = mutableListOf<String>()
      val cur = StringBuilder()
      var q = false
      var i = 0
      while (i < line.length) {
        val c = line[i]
        when {
          q && c == '"' && i + 1 < line.length && line[i + 1] == '"' -> { cur.append('"'); i++ }
          c == '"' -> q = !q
          !q && c == ',' -> { out.add(cur.toString()); cur.clear() }
          else -> cur.append(c)
        }
        i++
      }
      out.add(cur.toString())
      return out
    }
  }
}
