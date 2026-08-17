const socket = io();

function sendMessage() {
  const input = document.getElementById('message-input');
  const text = input.value.trim();

  if (text === '') return;

  socket.emit('send_message', {
    sender: 'Me',
    text: text,
    time: new Date().toLocaleTimeString()
  });

  input.value = '';
}

socket.on('receive_message', (data) => {
  const messages = document.getElementById('messages');

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';

  bubble.innerHTML = `
    <span class="sender">${data.sender}</span>
    <span class="text">${data.text}</span>
    <span class="time">${data.time}</span>
  `;

  messages.appendChild(bubble);
  messages.scrollTop = messages.scrollHeight;
});

document.getElementById('message-input').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') sendMessage();
});