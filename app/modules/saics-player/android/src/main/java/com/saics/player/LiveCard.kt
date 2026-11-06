package com.saics.player

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build
import android.os.Bundle

/**
 * What's playing as an Android 16 Live Update, which is what the status bar chip and OriginOS's
 * Origin Island show. The media notification can't be one: MediaStyle isn't a promotable style.
 * Only while playing; the media notification stays the place for the controls.
 */
class LiveCard(private val context: Context) {
  private val manager = context.getSystemService(NotificationManager::class.java)
  private var shown: String? = null

  /** For the service dump: can this app post one, and did the last card qualify? */
  var status = "not posted"
    private set

  fun update(title: String?, detail: String, playing: Boolean) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.BAKLAVA) return
    if (!playing || title.isNullOrEmpty()) {
      cancel()
      return
    }
    val key = "$title|$detail"
    if (key == shown) return
    if (manager.getNotificationChannel(CHANNEL) == null) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL, "Now playing (status bar)", NotificationManager.IMPORTANCE_LOW).apply {
          setShowBadge(false)
        },
      )
    }
    val builder = Notification.Builder(context, CHANNEL)
      .setSmallIcon(androidx.media3.session.R.drawable.media3_notification_small_icon)
      .setContentTitle(title)
      .setContentText(detail)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .setShortCriticalText(title.take(CHIP_CHARS))
      .addExtras(Bundle().apply { putBoolean(Notification.EXTRA_REQUEST_PROMOTED_ONGOING, true) })
    context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
      builder.setContentIntent(PendingIntent.getActivity(context, 1, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
    }
    val notification = builder.build()
    status = "permitted=${manager.areNotificationsEnabled()} promotedAllowed=${manager.canPostPromotedNotifications()} " +
      "promotable=${notification.hasPromotableCharacteristics()}"
    try {
      manager.notify(ID, notification)
      shown = key
    } catch (e: SecurityException) {
      status = "refused: $e"
    }
  }

  fun cancel() {
    if (shown != null) manager.cancel(ID)
    shown = null
  }

  companion object {
    private const val CHANNEL = "saics.live"
    private const val ID = 7301
    private const val CHIP_CHARS = 14
  }
}
