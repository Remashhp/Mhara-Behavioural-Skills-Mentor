/**
 * SkillMentor - Shared Utilities
 * Small helpers used across modules. Keep this file dependency-free.
 */

/**
 * Escape a string for safe insertion into innerHTML.
 * Prevents XSS from any server-provided text (skill names, feedback, tips).
 */
function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}