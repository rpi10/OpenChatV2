const socket = io();
const form = document.getElementById('form');
const input = document.getElementById('input');
const messages = document.getElementById('messages');
const usersList = document.getElementById('users-list');
const loginScreen = document.getElementById('login-screen');
const loginButton = document.getElementById('login-button');
const usernameInput = document.getElementById('username-input');
const passwordInput = document.getElementById('password-input');
const recordButton = document.getElementById('recordButton');
let mediaRecorder;
let audioChunks = [];
let currentUser = null;
let currentConversation = null;
let unseenMessages = {};
let currentUserAuthenticator = null; // Global for storing the user's authentificator

// Global variable for grouping day headers
let lastDisplayedDay = null;
const audioPreviewContainer = document.createElement('div');
audioPreviewContainer.id = 'audioPreviewContainer';
audioPreviewContainer.style.position = 'fixed';
audioPreviewContainer.style.bottom = '80px';
audioPreviewContainer.style.left = '50%';
audioPreviewContainer.style.transform = 'translateX(-50%)';
audioPreviewContainer.style.backgroundColor = '#fff';
audioPreviewContainer.style.padding = '10px';
audioPreviewContainer.style.border = '1px solid #ccc';
audioPreviewContainer.style.borderRadius = '8px';
audioPreviewContainer.style.display = 'none';
document.body.appendChild(audioPreviewContainer);

/** Debug Fetch Wrapper **/
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

/** Service Worker Registration **/
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js')
    .then(registration => {
      console.log('Service Worker registered with scope:', registration.scope);
    })
    .catch(error => {
      console.error('Service Worker registration failed:', error);
    });
}

/** Request Notification Permission **/
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

/** Auto-login if Credentials Are Stored & Initialize Mobile Nav **/
document.addEventListener('DOMContentLoaded', () => {
  const savedUsername = localStorage.getItem('username');
  const savedPassword = localStorage.getItem('password');
  if (savedUsername && savedPassword) {
    socket.emit('login', { username: savedUsername, password: savedPassword });
  }
  initializeMobileNav(); // Initialize mobile navigation when page loads
});

/** Play Beep Sound for New Messages **/
function playBeep() {
  const beepSound = document.getElementById('beep-sound');
  if (beepSound) {
    beepSound.play();
  }
}

/** Show Notification for Incoming Messages **/
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

/** Display a text message **/
function displayMessage({ from, msg, timestamp, dayLabel }) {
  if (lastDisplayedDay !== dayLabel) {
    const header = document.createElement('li');
    header.className = 'day-header';
    header.textContent = dayLabel;
    header.style.listStyleType = 'none';
    messages.appendChild(header);
    lastDisplayedDay = dayLabel;
  }
  const bubble = document.createElement('li');
  bubble.className = from === currentUser ? 'message-from-me' : 'message-from-others';
  bubble.style.listStyleType = 'none';
  if (bubble.classList.contains('message-from-others')) {
    bubble.style.marginLeft = '5px';
  }
  bubble.innerHTML = `<p class="message-text">${msg}</p>
                      <span class="message-time">${timestamp}</span>`;
  messages.appendChild(bubble);
  messages.scrollTop = messages.scrollHeight;
}

function displayFileMessage({ from, fileUrl, name, type, timestamp, dayLabel, recorded }) {
  const bubble = document.createElement('li');
  bubble.className = from === currentUser ? 'message-from-me' : 'message-from-others';
  bubble.style.listStyleType = 'none';
  if (bubble.classList.contains('message-from-others')) {
    bubble.style.marginLeft = '5px';
  }
  
  let content = '';
  if (type.startsWith('audio/')) {
    // Audio message with transcript button
    content = `
      <div class="file-message" style="position: relative;">
        <audio controls style="max-width: 200px; margin-bottom: 9px;">
          <source src="${fileUrl}" type="${type}">
          Your browser does not support the audio element.
        </audio>
        <div class="file-info">
          <button class="transcript-btn">Transcript</button>
        </div>
      </div>
    `;
  } else if (type.startsWith('image/')) {
    content = `
      <div class="file-message">
        <img src="${fileUrl}" alt="${name}" style="max-width: 200px; max-height: 200px; border-radius: 8px; margin-bottom: 13px; cursor: pointer;">
        <div class="file-info"></div>
      </div>
    `;
  } else if (type.startsWith('video/')) {
    content = `
      <div class="file-message">
        <video controls style="max-width: 200px; margin-bottom: 5px;">
          <source src="${fileUrl}" type="${type}">
          Your browser does not support the video element.
        </video>
        <div class="file-info"></div>
      </div>
    `;
  } else {
    content = `
      <div class="file-message">
        <div class="file-icon"></div>
        <div class="file-info">
          <a href="${fileUrl}" download="${name}" class="file-name">
            ${name}<img src="download.png" alt="File" style="width: 40px; height: 40px;">
          </a>
        </div>
      </div>
    `;
  }
  
  content += `<span class="message-time">${timestamp}</span>`;
  bubble.innerHTML = content;
  
  if (type.startsWith('audio/')) {
    const transcriptBtn = bubble.querySelector('.transcript-btn');
    if (transcriptBtn) {
      transcriptBtn.addEventListener('click', () => {
        transcribeAudio(fileUrl, bubble);
      });
    }
  }
  
  if (type.startsWith('image/')) {
    const img = bubble.querySelector('img');
    if (img) {
      img.addEventListener('click', () => showImageModal(img));
    }
  }
  
  messages.appendChild(bubble);
  messages.scrollTop = messages.scrollHeight;
}

/** Handle Login/Signup events **/
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

socket.on('login success', (data) => {
  console.log('Login success event received:', data);
  if (data && data.username && data.authentificator) {
    currentUser = data.username;
    currentUserAuthenticator = data.authentificator; // Save authentificator globally
  }
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

/** LINK DATABASE HANDLING **/
// Changed to use an HTTP POST request to '/link-database'
document.addEventListener('DOMContentLoaded', () => {
  const addDatabaseBtn = document.getElementById('add-database-btn');
  const linkDatabaseModal = document.getElementById('link-database-modal');
  const closeModalBtn = document.getElementById('close-modal');
  const linkDatabaseSubmit = document.getElementById('link-database-submit');
  const yourAuthenticatorSpan = document.getElementById('your-authenticator');
  const externalAuthenticatorInput = document.getElementById('external-authenticator-input');

  addDatabaseBtn.addEventListener('click', () => {
    console.log('Plus button clicked. Current authentificator:', currentUserAuthenticator);
    linkDatabaseModal.style.display = 'block';
    yourAuthenticatorSpan.textContent = currentUserAuthenticator || 'Not set';
  });

  closeModalBtn.addEventListener('click', () => {
    linkDatabaseModal.style.display = 'none';
  });

  window.addEventListener('click', (event) => {
    if (event.target === linkDatabaseModal) {
      linkDatabaseModal.style.display = 'none';
    }
  });

  linkDatabaseSubmit.addEventListener('click', async () => {
    const externalAuthenticator = externalAuthenticatorInput.value.trim();
    if (!externalAuthenticator) {
      alert('Please enter an authentificator.');
      return;
    }
    try {
      const response = await debugFetch('/link-database', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: currentUser, externalAuthenticator })
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Linking database failed');
      }
      const data = await response.json();
      alert(data.message);
    } catch (error) {
      alert('Error linking database: ' + error.message);
    }
    externalAuthenticatorInput.value = '';
    linkDatabaseModal.style.display = 'none';
  });
});

/** Handle Receiving Chat Messages **/
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
        name: msg.fileName,
        type: msg.fileType,
        timestamp: msg.timestamp,
        dayLabel: msg.dayLabel,
        recorded: msg.recorded
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

/** Update Conversation with Mobile Navigation **/
function updateConversation(conversation) {
  currentConversation = conversation;
  const chatHeader = document.getElementById('chat-header');
  chatHeader.innerHTML = `
    <button class="back-button">←</button>
    <h2>Chat with ${conversation}</h2>
  `;
  document.querySelectorAll('#users-list li').forEach(li => li.classList.remove('selected'));
  const item = Array.from(usersList.children).find(li => li.textContent.trim().includes(conversation));
  if (item) {
    item.classList.add('selected');
  }
  lastDisplayedDay = null;
  messages.innerHTML = '';
  socket.emit('load messages', { user: currentConversation });
  
  if (window.innerWidth <= 768) {
    showChat();
  }
  
  document.querySelector('.back-button').addEventListener('click', showUsersList);
}
  
form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (input.value && currentConversation) {
    socket.emit('chat message', { to: currentConversation, msg: input.value });
    input.value = '';
  }
});

/** FILE UPLOAD FUNCTIONALITY **/
const attachButton = document.getElementById('attachButton');
const fileInput = document.getElementById('fileInput');

attachButton.addEventListener('click', (e) => {
  e.preventDefault();
  fileInput.click();
});

fileInput.addEventListener('change', async (e) => {
  e.preventDefault();
  const file = fileInput.files[0];
  if (!file) {
    alert("Please select a file to upload.");
    return;
  }
  if (!currentConversation) {
    alert("Please select a conversation first.");
    fileInput.value = "";
    return;
  }
  attachButton.disabled = true;
  const formData = new FormData();
  formData.append('file', file);
  try {
    const response = await debugFetch('/upload', {
      method: 'POST',
      body: formData
    });
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Upload failed');
    }
    const data = await response.json();
    if (data.url) {
      const now = new Date();
      const fileMessage = {
        to: currentConversation,
        fileUrl: data.url,
        name: file.name,
        type: file.type,
        size: file.size,
        timestamp: formatTime(now),
        dayLabel: formatDayLabel(now),
        recorded: false
      };
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

/** Push Notifications Subscription **/
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

/** Helper Functions to Format Time and Day Label **/
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

/** Mobile Navigation Functions **/
function initializeMobileNav() {
  const chatHeader = document.getElementById('chat-header');
  if (!chatHeader.querySelector('.back-button')) {
    const backButton = document.createElement('button');
    backButton.className = 'back-button';
    backButton.innerHTML = '←';
    backButton.addEventListener('click', showUsersList);
    chatHeader.insertBefore(backButton, chatHeader.firstChild);
  }
}

function showChat() {
  document.body.classList.add('chat-active');
}

function showUsersList() {
  document.body.classList.remove('chat-active');
}

/** Modal Image Handling **/
function createImageModal() {
  const modal = document.createElement('div');
  modal.className = 'modal';
  const modalActions = document.createElement('div');
  modalActions.className = 'modal-actions';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'close-modal';
  closeBtn.innerHTML = '×';
  const downloadBtn = document.createElement('button');
  downloadBtn.className = 'download-modal';
  downloadBtn.textContent = 'Download';
  modalActions.appendChild(closeBtn);
  modalActions.appendChild(downloadBtn);
  const modalImg = document.createElement('img');
  modalImg.className = 'modal-content';
  modal.appendChild(modalActions);
  modal.appendChild(modalImg);
  document.body.appendChild(modal);
  return { modal, modalImg, closeBtn, downloadBtn };
}

const { modal, modalImg, closeBtn, downloadBtn } = createImageModal();

function showImageModal(imgElement) {
  modal.style.display = 'flex';
  modalImg.src = imgElement.src;
  downloadBtn.onclick = () => {
    const link = document.createElement('a');
    link.href = imgElement.src;
    link.download = imgElement.alt || 'image';
    link.click();
  };
  document.body.style.overflow = 'hidden';
}

closeBtn.onclick = () => {
  modal.style.display = 'none';
  document.body.style.overflow = '';
};

modal.onclick = (e) => {
  if (e.target === modal) {
    modal.style.display = 'none';
    document.body.style.overflow = '';
  }
};

// Recording and sending audio
recordButton.addEventListener('mousedown', async () => {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('Audio recording is not supported in this browser.');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];
    mediaRecorder.ondataavailable = event => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };
    mediaRecorder.start();
    console.log('Recording started...');
  } catch (err) {
    console.error('Error accessing microphone:', err);
    alert('Could not access microphone.');
  }
});

recordButton.addEventListener('mouseup', () => {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    mediaRecorder.onstop = () => {
      console.log('Recording stopped.');
      const audioBlob = new Blob(audioChunks, { type: 'audio/mp3' });
      showAudioPreview(audioBlob);
    };
  }
});

recordButton.addEventListener('touchstart', async (e) => {
  e.preventDefault();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('Audio recording is not supported in this browser.');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];
    mediaRecorder.ondataavailable = event => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };
    mediaRecorder.start();
    console.log('Recording started (touch)...');
  } catch (err) {
    console.error('Error accessing microphone:', err);
    alert('Could not access microphone.');
  }
});

recordButton.addEventListener('touchend', (e) => {
  e.preventDefault();
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    mediaRecorder.onstop = () => {
      console.log('Recording stopped (touch).');
      const audioBlob = new Blob(audioChunks, { type: 'audio/mp3' });
      showAudioPreview(audioBlob);
    };
  }
});

// Show audio preview with accept/cancel buttons
function showAudioPreview(audioBlob) {
  const audioUrl = URL.createObjectURL(audioBlob);
  const audioElement = document.createElement('audio');
  audioElement.controls = true;
  audioElement.src = audioUrl;
  const acceptButton = document.createElement('button');
  acceptButton.textContent = 'Send Audio';
  acceptButton.style.margin = '5px';
  acceptButton.addEventListener('click', () => {
    sendAudioMessage(audioBlob);
    hideAudioPreview();
  });
  const cancelButton = document.createElement('button');
  cancelButton.textContent = 'Cancel';
  cancelButton.style.margin = '5px';
  cancelButton.addEventListener('click', hideAudioPreview);
  audioPreviewContainer.innerHTML = '';
  audioPreviewContainer.appendChild(audioElement);
  audioPreviewContainer.appendChild(acceptButton);
  audioPreviewContainer.appendChild(cancelButton);
  audioPreviewContainer.style.display = 'block';
}

function hideAudioPreview() {
  audioPreviewContainer.style.display = 'none';
  audioPreviewContainer.innerHTML = '';
}

// Upload audio and mark as recorded
async function sendAudioMessage(audioBlob) {
  if (!currentConversation) {
    alert("Please select a conversation first.");
    return;
  }
  
  const timestamp = Date.now();
  const file = new File([audioBlob], `audio_${timestamp}.mp3`, { type: 'audio/mp3' });
  const formData = new FormData();
  formData.append('file', file);
  
  try {
    const uploadResponse = await debugFetch('/upload', {
      method: 'POST',
      body: formData
    });
    
    if (!uploadResponse.ok) {
      const errorData = await uploadResponse.json();
      throw new Error(errorData.error || 'Upload failed');
    }
    
    const uploadData = await uploadResponse.json();
    
    if (uploadData.url) {
      const now = new Date();
      const fileMessage = {
        to: currentConversation,
        fileUrl: uploadData.url,
        name: file.name,
        type: file.type,
        size: file.size,
        timestamp: formatTime(now),
        dayLabel: formatDayLabel(now),
        recorded: true
      };
      
      socket.emit('file message', fileMessage);
    }
  } catch (error) {
    console.error('Upload error:', error);
    alert(`Failed to upload audio: ${error.message}`);
  }
}

// Transcribe audio and swap UI
async function transcribeAudio(fileUrl, bubble) {
  const originalContent = bubble.innerHTML;
  const transcriptBtn = bubble.querySelector('.transcript-btn');
  if (transcriptBtn) {
    transcriptBtn.disabled = true;
    transcriptBtn.textContent = 'Transcribing...';
  }
  
  try {
    const transcribeResponse = await fetch('/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: fileUrl })
    });
    
    if (!transcribeResponse.ok) {
      const errorData = await transcribeResponse.json();
      throw new Error(errorData.error || 'Transcription failed');
    }
    
    const data = await transcribeResponse.json();
    const transcriptionText = data.text;
    
    const transcriptHTML = `
      <div class="transcript-view">
        <p>${transcriptionText}</p>
        <button class="return-audio-btn">Return to Audio</button>
      </div>
    `;
    bubble.innerHTML = transcriptHTML;
    
    const returnBtn = bubble.querySelector('.return-audio-btn');
    if (returnBtn) {
      returnBtn.addEventListener('click', () => {
        bubble.innerHTML = originalContent;
        const newTranscriptBtn = bubble.querySelector('.transcript-btn');
        if (newTranscriptBtn) {
          newTranscriptBtn.disabled = false;
          newTranscriptBtn.textContent = 'Transcript';
          newTranscriptBtn.addEventListener('click', () => {
            transcribeAudio(fileUrl, bubble);
          });
        }
      });
    }
    
  } catch (error) {
    console.error("Error during transcription:", error);
    alert("Error during transcription: " + error.message);
    if (transcriptBtn) {
      transcriptBtn.disabled = false;
      transcriptBtn.textContent = 'Transcript';
    }
  }
}

function showTranscript(bubble, fileUrl, transcriptText) {
  const originalContent = bubble.innerHTML;
  const transcriptHTML = `
    <div class="transcript-view">
      <p>${transcriptText}</p>
      <button class="return-audio-btn">Return to Audio</button>
    </div>
  `;
  bubble.innerHTML = transcriptHTML;
  const returnBtn = bubble.querySelector('.return-audio-btn');
  returnBtn.addEventListener('click', () => {
    bubble.innerHTML = originalContent;
    const newTranscriptBtn = bubble.querySelector('.transcript-btn');
    if (newTranscriptBtn) {
      newTranscriptBtn.addEventListener('click', () => {
        showTranscript(bubble, fileUrl, transcriptText);
      });
    }
  });
}
