// sw.js

self.addEventListener('install', event => {
    console.log('Service Worker installed');
});

self.addEventListener('activate', event => {
    console.log('Service Worker activated');
});

self.addEventListener('push', event => {
    // Ensure the event has data
    if (event.data) {
        const data = event.data.json();
        const options = {
            body: data.message,
            icon: '/path/to/icon.png', // Add your icon path here
            badge: '/path/to/badge.png', // Optional: Add a badge image
            tag: data.tag || 'default-tag' // Tag helps prevent multiple notifications for the same event
        };

        // Show the notification
        event.waitUntil(
            self.registration.showNotification(data.title, options)
        );
    } else {
        console.error('Push event but no data!');
    }
});

self.addEventListener('notificationclick', event => {
    event.notification.close();

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
            if (clientList.length > 0) {
                // If there are any clients (open browser windows), focus the first one
                return clientList[0].focus();
            }
            // If no windows are open, open a new one
            return clients.openWindow('/');
        })
    );
});
