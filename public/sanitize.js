// Shared by the browser and regression tests. DOMPurify is served locally.
window.sanitizeHTML = function sanitizeHTML(html) {
    return window.DOMPurify.sanitize(html == null ? '' : String(html), {
        ALLOWED_TAGS: ['h3', 'h4', 'p', 'ul', 'ol', 'li', 'strong', 'em', 'br', 'div', 'a'],
        ALLOWED_ATTR: ['href', 'class', 'title'],
        ALLOW_DATA_ATTR: false,
        ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|\/)/i,
    });
};
