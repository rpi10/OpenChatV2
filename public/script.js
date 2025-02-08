const socket = io();
const form = document.getElementById('form');
const input = document.getElementById('input');
const messages = document.getElementById('messages');
const usersList = document.getElementById('users-list');
const loginScreen = document.getElementById('login-screen');
const loginButton = document.getElementById('login-button');
const usernameInput = document.getElementById('username-input');
const passwordInput = document.getElementById('password-input');
let currentUser = null;
let currentConversation = null;
let unseenMessages = {};

function debugFetch(url, options) {
  console.log(`Fetching ${url} with options:`, options);
  return fetch(url, options).then(async response => {
    const clone = response.clone();
    try {
      const data = await clone.json();
      console.log('Response:', {
        status: response.status,
        statusText: response.statusText,
        data
      });
    } catch (e) {
      console.log('Response (not JSON):', {
        status: response.status,
        statusText: response.statusText
      });
    }
    return response;
  });
}

// Global variable for grouping day headers
let lastDisplayedDay = null;

// ---------------------------
// Service Worker Registration
// ---------------------------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js')
    .then(registration => {
      console.log('Service Worker registered with scope:', registration.scope);
    })
    .catch(error => {
      console.error('Service Worker registration failed:', error);
    });
}

// ---------------------------
// Request Notification Permission
// ---------------------------
function requestNotificationPermission() {
  if (Notification.permission === 'default') {
    Notification.requestPermission().then(permission => {
      if (permission === 'granted') {
        console.log('Notification permission granted.');
      } else {
        console.error('Notification permission denied.');
      }
    });
  }
}
requestNotificationPermission();

// ---------------------------
// Auto-login if Credentials Are Stored
// ---------------------------
document.addEventListener('DOMContentLoaded', () => {
  const savedUsername = localStorage.getItem('username');
  const savedPassword = localStorage.getItem('password');
  if (savedUsername && savedPassword) {
    socket.emit('login', { username: savedUsername, password: savedPassword });
  }
});

// ---------------------------
// Play Beep Sound for New Messages
// ---------------------------
function playBeep() {
  const beepSound = document.getElementById('beep-sound');
  beepSound.play();
}

// ---------------------------
// Show Notification for Incoming Messages
// ---------------------------
function showNotification(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    navigator.serviceWorker.ready.then(function(registration) {
      registration.showNotification(title, {
        body: body,
        icon: '/path/to/icon.png' // Optional: add an icon
      });
    }).catch(error => {
      console.error('Error showing notification:', error);
    });
  }
}

// ---------------------------
// Display text message
// ---------------------------
function displayMessage({ from, msg, timestamp, dayLabel }) {
  if (lastDisplayedDay !== dayLabel) {
    const header = document.createElement('li');
    header.className = 'day-header';
    header.textContent = dayLabel;
    messages.appendChild(header);
    lastDisplayedDay = dayLabel;
  }
  const bubble = document.createElement('li');
  bubble.className = from === currentUser ? 'message-from-me' : 'message-from-others';
  bubble.innerHTML = `<p class="message-text">${msg}</p>
                      <span class="message-time">${timestamp}</span>`;
  messages.appendChild(bubble);
  messages.scrollTop = messages.scrollHeight;
}

// ---------------------------
// Display file message with preview in the bubble
// ---------------------------
function displayFileMessage({ from, fileUrl, name, type, timestamp, dayLabel }) {
  const bubble = document.createElement('li');
  bubble.className = from === currentUser ? 'message-from-me' : 'message-from-others';
  
  let content = '';
  if (type.startsWith('image/')) {
    content = `
      <div class="file-message">
        <img src="${fileUrl}" alt="${name}" style="max-width: 200px; max-height: 200px; border-radius: 8px; margin-bottom: 5px;">
        <div class="file-info">
          <a href="${fileUrl}" download="${name}" class="file-name">${name}</a>
        </div>
      </div>
    `;
  } else if (type.startsWith('audio/')) {
    content = `
      <div class="file-message">
        <audio controls style="max-width: 200px; margin-bottom: 5px;">
          <source src="${fileUrl}" type="${type}">
          Your browser does not support the audio element.
        </audio>
        <div class="file-info">
          <a href="${fileUrl}" download="${name}" class="file-name">${name}</a>
        </div>
      </div>
    `;
  } else if (type.startsWith('video/')) {
    content = `
      <div class="file-message">
        <video controls style="max-width: 200px; margin-bottom: 5px;">
          <source src="${fileUrl}" type="${type}">
          Your browser does not support the video element.
        </video>
        <div class="file-info">
          <a href="${fileUrl}" download="${name}" class="file-name">${name}</a>
        </div>
      </div>
    `;
  } else {
    content = `
      <div class="file-message">
        <div class="file-icon">
          <img src="https://cdn-icons-png.flaticon.com/512/2965/2965332.png" alt="File" style="width: 40px; height: 40px;">
        </div>
        <div class="file-info">
          <a href="${fileUrl}" download="${name}" class="file-name">${name}</a>
        </div>
      </div>
    `;
  }
  content += `<span class="message-time">${timestamp}</span>`;
  bubble.innerHTML = content;
  messages.appendChild(bubble);
  messages.scrollTop = messages.scrollHeight;
}

// ---------------------------
// Handle Login/Signup events
// ---------------------------
loginButton.addEventListener('click', () => {
  const username = usernameInput.value.trim();
  const password = passwordInput.value.trim();
  if (username && password) {
    localStorage.setItem('username', username);
    localStorage.setItem('password', password);
    socket.emit('login', { username, password });
  } else {
    alert('Please enter both username and password.');
  }
});

socket.on('login success', (username) => {
  currentUser = username;
  loginScreen.style.display = 'none';
  socket.emit('load users');
  subscribeToPushNotifications();
});

socket.on('prompt signup', (message) => {
  const confirmed = confirm(message);
  if (confirmed) {
    const username = usernameInput.value.trim();
    const password = passwordInput.value.trim();
    if (username && password) {
      socket.emit('signup', { username, password });
    } else {
      alert('Please enter both username and password.');
    }
  }
});

socket.on('signup successful', (username) => {
  alert('Signup successful! You are now logged in.');
  currentUser = username;
  loginScreen.style.display = 'none';
  socket.emit('load users');
});

socket.on('login failed', (message) => {
  alert(message);
});

socket.on('signup failed', (message) => {
  alert(message);
});

socket.on('password setup successful', () => {
  alert('Password setup successful! You are now logged in.');
  loginScreen.style.display = 'none';
  socket.emit('load users');
});

socket.on('setup failed', (message) => {
  alert(message);
});
  
// ---------------------------
// Handle Receiving Chat Messages
// ---------------------------
socket.on('chat message', (data) => {
  displayMessage(data);
  if (data.from !== currentUser) {
    playBeep();
    showNotification(data.from, data.msg);
    unseenMessages[data.from] = (unseenMessages[data.from] || 0) + 1;
    const userItem = Array.from(usersList.children).find(li => li.textContent.trim().startsWith(data.from));
    if (userItem) {
      let count = userItem.querySelector('.unseen-count');
      if (!count) {
        count = document.createElement('span');
        count.className = 'unseen-count';
        userItem.appendChild(count);
      }
      count.textContent = unseenMessages[data.from];
    }
  }
});

socket.on('file message', (data) => {
  displayFileMessage(data);
  if (data.from !== currentUser) {
    playBeep();
    showNotification(data.from, 'Sent you a file');
  }
});
  
socket.on('chat history', (msgs) => {
  lastDisplayedDay = null;
  messages.innerHTML = '';
  msgs.forEach(msg => {
    if (msg.isFileMessage) {
      displayFileMessage({
        from: msg.from,
        fileUrl: msg.fileUrl,
        name: msg.fileName,   // mapping DB field to display field
        type: msg.fileType,
        timestamp: msg.timestamp,
        dayLabel: msg.dayLabel
      });
    } else {
      displayMessage(msg);
    }
  });
});

socket.on('users', (usersArr) => {
  usersList.innerHTML = '';
  usersArr.filter(user => user.username !== currentUser).forEach(user => {
    const item = document.createElement('li');
    item.textContent = `${user.username}`;
    if (user.online) {
      item.innerHTML = `<span class="online-status online"></span> ${item.textContent}`;
    } else {
      item.innerHTML = `<span class="online-status offline"></span> ${item.textContent}`;
    }
    item.addEventListener('click', () => updateConversation(user.username));
    usersList.appendChild(item);
  });
});

function updateConversation(conversation) {
  currentConversation = conversation;
  document.getElementById('chat-header').textContent = `Chat with ${conversation}`;
  document.querySelectorAll('#users-list li').forEach(li => li.classList.remove('selected'));
  const item = Array.from(usersList.children).find(li => li.textContent.trim().includes(conversation));
  if (item) {
    item.classList.add('selected');
  }
  lastDisplayedDay = null;
  messages.innerHTML = '';
  socket.emit('load messages', { user: currentConversation });
}
  
form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (input.value && currentConversation) {
    socket.emit('chat message', { to: currentConversation, msg: input.value });
    input.value = '';
  }
});

// ---------------------------
// FILE UPLOAD FUNCTIONALITY
// ---------------------------
// Get the attachment button and hidden file input
const attachButton = document.getElementById('attachButton');
const fileInput = document.getElementById('fileInput');

// When the attachment button is clicked, trigger the file input dialog
attachButton.addEventListener('click', (e) => {
  e.preventDefault();
  fileInput.click();
});

// When a file is selected, automatically upload it
fileInput.addEventListener('change', async (e) => {
  e.preventDefault();
  
  const file = fileInput.files[0];
  if (!file) {
    alert("Please select a file to upload.");
    return;
  }
  
  if (!currentConversation) {
    alert("Please select a conversation first.");
    fileInput.value = ""; // Reset file input if no conversation is selected
    return;
  }

  // Show loading state by disabling the attachment button
  attachButton.disabled = true;
  
  const formData = new FormData();
  formData.append('file', file);

  try {
    console.log('Starting upload for file:', {
      name: file.name,
      type: file.type,
      size: file.size
    });

    const response = await debugFetch('/upload', {
      method: 'POST',
      body: formData
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Upload failed');
    }

    const data = await response.json();
    console.log('Upload successful:', data);

    if (data.url) {
      const now = new Date();
      
      const fileMessage = {
        to: currentConversation,
        fileUrl: data.url,
        name: file.name,
        type: file.type,
        size: file.size,
        timestamp: formatTime(now),
        dayLabel: formatDayLabel(now)
      };

      console.log('Emitting file message:', fileMessage);
      socket.emit('file message', fileMessage);
      fileInput.value = "";
      
    }
  } catch (error) {
    console.error('Upload error:', error);
    alert(`Failed to upload file: ${error.message}`);
  } finally {
    attachButton.disabled = false;
  }
});

function subscribeToPushNotifications() {
  navigator.serviceWorker.ready.then(function(registration) {
    registration.pushManager.getSubscription().then(function(subscription) {
      if (!subscription) {
        registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToUint8Array('<YOUR_VAPID_PUBLIC_KEY>')
        }).then(function(subscription) {
          socket.emit('subscribe', subscription);
        }).catch(function(error) {
          console.error('Failed to subscribe to push notifications:', error);
        });
      }
    });
  });
}
  
function urlB64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
    .replace(/\-/g, '+')
    .replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function formatTime(date) {
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const seconds = date.getSeconds().toString().padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function formatDayLabel(date) {
  const day = date.getDate().toString().padStart(2, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const year = date.getFullYear();
  return `${day}-${month}-${year}`;
}
