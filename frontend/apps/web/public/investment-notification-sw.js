self.addEventListener('push', event => {
  let payload = {}
  try { payload = event.data ? event.data.json() : {} } catch { payload = {} }
  const notificationId = String(payload.notificationId || '')
  event.waitUntil(self.registration.showNotification(String(payload.title || '投研通知'), {
    body: String(payload.body || ''),
    icon: '/icons/app-icon-001/icon-192.png',
    badge: '/icons/app-icon-001/favicon-48x48.png',
    tag: notificationId || undefined,
    data: { notificationId },
  }))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const notificationId = String(event.notification.data?.notificationId || '')
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clients => {
    const client = clients[0]
    if (client) {
      await client.focus()
      client.postMessage({ notificationId })
      return
    }
    const opened = await self.clients.openWindow('/')
    opened?.postMessage({ notificationId })
  }))
})
