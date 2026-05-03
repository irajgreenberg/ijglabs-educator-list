const STORE_KEY = 'ijg-educator-list-theme';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

let mode = 'educator';

function initTheme() {
  const button = $('.theme-toggle');
  const set = (theme) => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(STORE_KEY, theme);
    if (button) button.textContent = theme === 'dark' ? 'light' : 'dark';
  };
  set(localStorage.getItem(STORE_KEY) || 'dark');
  button?.addEventListener('click', () => set(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function fieldValue(form, name) {
  const element = form.elements[name];
  return element ? String(element.value || '').trim() : '';
}

function clearErrors(form) {
  $$('.field-error', form).forEach((node) => node.remove());
  $$('.has-error', form).forEach((node) => node.classList.remove('has-error'));
  const banner = $('#server-error');
  if (banner) { banner.hidden = true; banner.textContent = ''; }
}

function addFieldError(input, message) {
  const field = input?.closest('.field, .radio-field') || input?.parentElement;
  if (!field) return;
  field.classList.add('has-error');
  const error = document.createElement('div');
  error.className = 'field-error';
  error.textContent = message;
  field.appendChild(error);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validatePayload(form, payload) {
  let ok = true;
  const flag = (name, message) => {
    const input = form.elements[name];
    addFieldError(input, message);
    ok = false;
  };
  if (!payload.name) flag(mode === 'educator' ? 'name' : 'supporter_name', 'Required.');
  if (!payload.email) flag(mode === 'educator' ? 'email' : 'supporter_email', 'Required.');
  else if (!EMAIL_RE.test(payload.email)) flag(mode === 'educator' ? 'email' : 'supporter_email', 'Use a valid email address.');
  if (mode === 'educator') {
    if (!payload.title) flag('title', 'Required.');
    if (!payload.institution) flag('institution', 'Required.');
    if (!payload.use_case) flag('use_case', 'Required.');
    if (payload.expected_students !== undefined && payload.expected_students !== '') {
      const number = Number(payload.expected_students);
      if (!Number.isInteger(number) || number < 0 || number > 100000) flag('expected_students', 'Use an integer between 0 and 100000.');
    }
  } else if (!payload.supporter_interest) {
    flag('supporter_interest', 'Required.');
  }
  if (new Blob([JSON.stringify(payload)]).size > 16 * 1024) {
    const banner = $('#server-error');
    banner.textContent = 'Please shorten the application; payload must be under 16KB.';
    banner.hidden = false;
    ok = false;
  }
  return ok;
}

function buildPayload(form) {
  if (mode === 'supporter') {
    return {
      kind: 'supporter',
      name: fieldValue(form, 'supporter_name'),
      email: fieldValue(form, 'supporter_email'),
      supporter_interest: fieldValue(form, 'supporter_interest'),
      notes: fieldValue(form, 'supporter_notes')
    };
  }
  const payload = {
    kind: 'educator',
    name: fieldValue(form, 'name'),
    email: fieldValue(form, 'email'),
    title: fieldValue(form, 'title'),
    institution: fieldValue(form, 'institution'),
    use_case: fieldValue(form, 'use_case'),
    expected_students: fieldValue(form, 'expected_students'),
    institution_budget: form.elements.institution_budget?.value || '',
    notes: fieldValue(form, 'notes')
  };
  if (payload.expected_students === '') delete payload.expected_students;
  return payload;
}

function initSupporterToggle() {
  const toggle = $('#supporter-toggle');
  const supporter = $('#supporter-fields');
  const educatorGroups = $$('[data-mode="educator"]');
  const submit = $('#submit-button');
  toggle?.addEventListener('click', () => {
    mode = mode === 'educator' ? 'supporter' : 'educator';
    const supporterMode = mode === 'supporter';
    supporter.hidden = !supporterMode;
    educatorGroups.forEach((group) => { group.hidden = supporterMode; });
    toggle.setAttribute('aria-expanded', String(supporterMode));
    toggle.textContent = supporterMode ? '− Return to educator application' : "+ I'm not an educator but want to support the project";
    submit.textContent = supporterMode ? 'Send interest' : 'Send application';
    clearErrors($('#application-form'));
  });
}

function initEmailNote() {
  const email = document.querySelector('input[name="email"]');
  const note = $('#email-note');
  const educational = /\.(edu|org|school)$|\.edu\.[a-z]{2,}$|\.ac\.[a-z]{2,}$|\.k12\./i;
  email?.addEventListener('input', () => {
    const value = email.value.trim();
    const domain = value.split('@')[1] || '';
    note.textContent = domain && !educational.test(domain) ? 'educational email recommended; this will not block submission.' : '';
  });
}

function renderSuccess() {
  $('#application-shell').innerHTML = `<div class="confirmation">
    <p class="eyebrow">04 / received</p>
    <h3>Thanks — we have your details.</h3>
    <p>We review applications regularly. You will hear back at the email address you provided.</p>
  </div>`;
}

function initForm() {
  const form = $('#application-form');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearErrors(form);
    const payload = buildPayload(form);
    if (!validatePayload(form, payload)) return;
    const submit = $('#submit-button');
    const original = submit.textContent;
    submit.disabled = true;
    submit.textContent = 'Sending…';
    try {
      const response = await fetch('/api/applications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
      renderSuccess();
    } catch (error) {
      const banner = $('#server-error');
      banner.textContent = escapeHtml(error.message || 'Submission failed.');
      banner.hidden = false;
      submit.disabled = false;
      submit.textContent = original;
    }
  });
}

initTheme();
initSupporterToggle();
initEmailNote();
initForm();
