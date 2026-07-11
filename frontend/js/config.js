// frontend/js/config.js
const CONFIG = {
  API_BASE: window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
    ? "http://127.0.0.1:8000/api" 
    : "https://mhara-behavioural-skills-mentor-production.up.railway.app/api"

};