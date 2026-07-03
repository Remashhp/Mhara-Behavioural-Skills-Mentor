// frontend/js/config.js
const CONFIG = {
  API_BASE: window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
    ? "http://127.0.0.1:8000/api" 
    : "https://mhara-protocol-engine.onrender.com/api" // ضع هنا رابط الـ Render الخاص بك بعد رفعه
};