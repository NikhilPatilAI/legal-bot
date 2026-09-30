// Browser client for the Legal Bot API. No framework and no build step.
// Answers are rendered with DOM APIs (textContent), never innerHTML, so model
// or document text can never inject markup into the page.

const $ = (selector) => document.querySelector(selector);
const conversation = $('#conversation');
const form = $('#ask');
const question = $('#question');
const send = $('#send');
const apiKey = $('#api-key');
const asOf = $('#as-of');

apiKey.value = sessionStorage.getItem('legal-bot.api-key') ?? '';
apiKey.addEventListener('change', () => sessionStorage.setItem('legal-bot.api-key', apiKey.value));

function headers(extra = {}) {
  const key = apiKey.value.trim();
  return { ...extra, ...(key ? { authorization: `Bearer ${key}` } : {}) };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Minimal Markdown: "## " headings, "- " bullets, "> " quotes, **bold**.
function renderAnswer(markdown) {
  const container = element('div', 'answer-text');
  let list = null;
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) {
      list = null;
      continue;
    }
    if (/^#{1,3}\s/.test(line)) {
      list = null;
      container.append(inline(element('h3'), line.replace(/^#{1,3}\s+/, '')));
    } else if (/^[-*]\s/.test(line)) {
      if (!list) container.append((list = element('ul')));
      list.append(inline(element('li'), line.replace(/^[-*]\s+/, '')));
    } else if (line.startsWith('>')) {
      list = null;
      container.append(inline(element('blockquote'), line.replace(/^>\s?/, '')));
    } else {
      list = null;
      container.append(inline(element('p'), line));
    }
  }
  return container;
}

function inline(node, text) {
  for (const part of text.split(/(\*\*[^*]+\*\*)/g)) {
    if (part.startsWith('**') && part.endsWith('**'))
      node.append(element('strong', '', part.slice(2, -2)));
    else if (part) node.append(document.createTextNode(part));
  }
  return node;
}

function renderResult(turn, result) {
  turn.querySelector('.progress')?.remove();
  const card = element('article', `answer${result.abstained ? ' declined' : ''}`);
  const sourcesOnly = result.abstained && result.citations.length > 0;
  const confidence =
    typeof result.confidence === 'number' && !result.abstained
      ? ` · confidence ${Math.round(result.confidence * 100)}%`
      : '';
  card.append(
    element(
      'span',
      'badge',
      sourcesOnly ? 'Sources only' : result.abstained ? 'Declined' : `Grounded answer${confidence}`,
    ),
  );
  card.append(renderAnswer(result.answer));
  if (result.citations.length) {
    const sources = element('ol', 'sources');
    for (const citation of result.citations) {
      const item = element('li');
      const label = `${citation.title} · ${
        citation.sectionIdentifier.startsWith('Page ')
          ? citation.sectionIdentifier.toLowerCase()
          : `section ${citation.sectionIdentifier}`
      }`;
      const url = citation.officialSourceUrl;
      if (url && url.startsWith('https://')) {
        const link = element('a', '', label);
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        item.append(link);
      } else item.textContent = label;
      sources.append(item);
    }
    card.append(element('h4', '', 'Sources'), sources);
  }
  if (result.warnings.length) {
    const notes = element('details', 'notes');
    notes.append(element('summary', '', `Checks and notes (${result.warnings.length})`));
    const list = element('ul');
    for (const warning of result.warnings) list.append(element('li', '', warning));
    notes.append(list);
    card.append(notes);
  }
  turn.append(card);
}

function renderError(turn, message) {
  turn.querySelector('.progress')?.remove();
  turn.append(element('p', 'error', message));
}

async function ask(text) {
  const turn = element('section', 'turn');
  turn.append(element('p', 'question', text));
  const progress = element('p', 'progress', 'Checking the question…');
  turn.append(progress);
  $('#welcome')?.remove();
  conversation.append(turn);
  conversation.setAttribute('aria-busy', 'true');
  send.disabled = true;
  turn.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const response = await fetch('/v1/ask', {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json', accept: 'application/x-ndjson' }),
      body: JSON.stringify({ question: text, ...(asOf.value ? { asOfDate: asOf.value } : {}) }),
    });
    if (!response.ok) {
      const problem = await response.json().catch(() => null);
      return renderError(turn, problem?.detail ?? `Request failed (${response.status})`);
    }
    // Newline-delimited JSON: progress events, then one result or error.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    for (;;) {
      const { value, done } = await reader.read();
      buffered += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines.filter(Boolean)) {
        const event = JSON.parse(line);
        if (event.type === 'progress') progress.textContent = `${event.data.message}…`;
        else if (event.type === 'result') renderResult(turn, event.data);
        else if (event.type === 'error') renderError(turn, event.error.detail);
      }
      if (done) break;
    }
  } catch {
    renderError(turn, 'The server could not be reached.');
  } finally {
    conversation.setAttribute('aria-busy', 'false');
    send.disabled = false;
  }
}

async function loadStatus() {
  const target = $('#corpus');
  try {
    const response = await fetch('/v1/status', { headers: headers() });
    if (!response.ok) {
      target.textContent =
        response.status === 401
          ? 'Enter the API key in Settings to use this server.'
          : 'Corpus status unavailable.';
      return;
    }
    const { data } = await response.json();
    const documents = data.categories.reduce((sum, item) => sum + item.documents, 0);
    const areas = data.categories.map((item) => item.category).join(', ');
    target.textContent = `${documents} document${documents === 1 ? '' : 's'} indexed (${areas}) · corpus built ${new Date(
      data.lastSuccessfulIngestionAt,
    ).toLocaleDateString()}`;
  } catch {
    target.textContent = 'Corpus status unavailable.';
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = question.value.trim();
  if (!text || send.disabled) return;
  question.value = '';
  void ask(text);
});
question.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});
for (const button of document.querySelectorAll('.example'))
  button.addEventListener('click', () => void ask(button.textContent));
apiKey.addEventListener('change', () => void loadStatus());

void loadStatus();
