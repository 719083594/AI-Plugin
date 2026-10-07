export function localClock(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return { date: `${value.year}-${value.month}-${value.day}`, time: `${value.hour}:${value.minute}` }
}

export function checkDailyCleanup(client, now = new Date()) {
  const settings = client.config().retention
  if (!settings.dailyCleanupEnabled) return { skipped: true, reason: 'disabled' }
  const clock = localClock(now, settings.dailyCleanupTimezone)
  const marker = client.storage.maintenance('daily-history-cleanup')
  const scheduleKey = settings.dailyCleanupTimezone + '@' + settings.dailyCleanupTime
  // First installation after the configured time waits until the next day.
  if (!marker) {
    client.storage.setMaintenance('daily-history-cleanup', { lastDate: clock.time >= settings.dailyCleanupTime ? clock.date : '', initialized: true, scheduleKey })
    return { skipped: true, reason: 'initialized' }
  }
  if (marker.scheduleKey !== scheduleKey) {
    const alreadyRanToday = marker.executed && marker.lastDate === clock.date
    client.storage.setMaintenance('daily-history-cleanup', { ...marker, scheduleKey, lastDate: alreadyRanToday || clock.time >= settings.dailyCleanupTime ? clock.date : (marker.executed ? marker.lastDate : '') })
    return { skipped: true, reason: 'configuration-updated' }
  }
  if (clock.time < settings.dailyCleanupTime || marker.lastDate >= clock.date) return { skipped: true, reason: 'not-due' }
  return client.clearHistory({ scheduledDate: clock.date, scheduleKey })
}
