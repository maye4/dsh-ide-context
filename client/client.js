// dsh-ide-context client half (ModuleLoader format, hand-written ES5-ish JS,
// no build step): a small chip in the composer card's top padding showing which
// IDE selection the next turn will carry, with a click to switch the IDE
// reading off/on for this session. State is pushed by the host over a
// server-sent-events stream read with fetch() (so the guard header applies),
// with a slow fallback poll and auto-reconnect. The browser never talks to the
// IDE, so the single server-side IDE connection is shared.
window.__ModuleLoader__.load({ id: '@deepseek-ai/dsh-ide-context', factory: function (require) {
  var module = { exports: {} }
  var exports = module.exports
  var React = require('react')
  var h = React.createElement

  var ROUTE = '/ide-context/api'
  var FALLBACK_POLL_MS = 10000
  var RECONNECT_MIN_MS = 500
  var RECONNECT_MAX_MS = 10000
  var HEADERS = { 'x-dsh-ide-context': '1' }

  function fetchState(sessionId) {
    var q = sessionId ? '?session=' + encodeURIComponent(sessionId) : ''
    return fetch(ROUTE + '/state' + q, { headers: HEADERS, credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (body) { return body && body.ok ? body.value : null })
  }

  /**
   * Read the SSE stream until it ends or `signal` aborts; calls onState for
   * each `data:` frame. Resolves when the stream closes.
   */
  function readEvents(sessionId, signal, onState, onOpen) {
    var q = sessionId ? '?session=' + encodeURIComponent(sessionId) : ''
    return fetch(ROUTE + '/events' + q, { headers: HEADERS, credentials: 'same-origin', cache: 'no-store', signal: signal })
      .then(function (r) {
        if (!r.ok || !r.body) throw new Error('events ' + r.status)
        onOpen()
        var reader = r.body.getReader()
        var decoder = new TextDecoder()
        var buffer = ''
        function pump() {
          return reader.read().then(function (chunk) {
            if (chunk.done) return
            buffer += decoder.decode(chunk.value, { stream: true })
            var cut
            while ((cut = buffer.indexOf('\n\n')) !== -1) {
              var frame = buffer.slice(0, cut)
              buffer = buffer.slice(cut + 2)
              var data = frame.split('\n').filter(function (l) { return l.indexOf('data:') === 0 })
                .map(function (l) { return l.slice(5).trim() }).join('\n')
              if (data) { try { onState(JSON.parse(data)) } catch (e) { /* ignore bad frame */ } }
            }
            return pump()
          })
        }
        return pump()
      })
  }

  function postToggle(sessionId, enabled) {
    return fetch(ROUTE + '/toggle', {
      method: 'POST',
      credentials: 'same-origin',
      headers: Object.assign({ 'content-type': 'application/json' }, HEADERS),
      body: JSON.stringify({ session: sessionId, enabled: enabled })
    }).then(function (r) { return r.json() }).then(function (body) { return body && body.ok ? body.value : null })
  }

  /**
   * Pure view model. Wording follows Claude Code's indicator: "N lines
   * selected"; file and range live in the tooltip. Returns null to hide.
   */
  function view(state, hasSession) {
    if (!state) return null
    var ide = state.ideName || 'IDE'
    var clickHint = hasSession ? '\nClick to stop including IDE context in this session.' : ''
    if (!state.enabled) {
      return {
        tone: 'off', text: 'IDE context off',
        title: 'IDE context is off for this session: your ' + ide + ' selection will not be sent.' + (hasSession ? '\nClick to turn it back on.' : '')
      }
    }
    if (state.status === 'disconnected') {
      return {
        tone: 'muted', text: 'IDE not connected',
        title: 'No ' + ide + ' connection for this session\u2019s folder (needs a VS Code / Antigravity window on this folder with Claude Code installed).' + clickHint
      }
    }
    if (state.status !== 'selection') return null
    var n = state.lineCount || (state.endLine - state.startLine + 1)
    var range = state.startLine === state.endLine ? 'line ' + state.startLine : 'lines ' + state.startLine + '\u2013' + state.endLine
    var sent = state.pending === false
    return {
      tone: sent ? 'sent' : 'on', text: n + (n === 1 ? ' line selected' : ' lines selected'),
      title: state.label + '\n' + state.filePath + ' (' + range + ')' + (state.truncated ? '\nLong selection: only the first 8000 characters are sent.' : '') + '\n' +
        (sent ? 'Already sent in this session; sent again only if it changes.' : 'Will be included with your next message.') + clickHint
    }
  }

  // The chip sits absolutely inside the composer card's existing top padding
  // (rendered through the card's overlay slot), so it never adds a line, never
  // changes the card's height and never touches the footer controls.
  var STYLE = {
    wrap: {
      position: 'absolute', top: '0px', left: '14px', right: '14px', height: '12px',
      display: 'flex', alignItems: 'center', pointerEvents: 'none', minWidth: 0, zIndex: 1
    },
    base: {
      display: 'inline-flex', alignItems: 'center', gap: '3px', maxWidth: '100%', minWidth: 0, height: '12px',
      padding: 0, margin: 0, border: 'none', borderRadius: '3px', background: 'transparent',
      fontSize: '10px', lineHeight: '12px', fontFamily: 'inherit', whiteSpace: 'nowrap', overflow: 'hidden',
      cursor: 'pointer', pointerEvents: 'auto', flex: '0 1 auto'
    },
    icon: { flex: 'none', width: '10px', height: '10px', display: 'block' },
    text: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    on: { color: 'rgb(37,99,235)' },
    sent: { color: 'inherit', opacity: 0.6 },
    muted: { color: 'inherit', opacity: 0.45 },
    off: { color: 'rgb(220,38,38)', opacity: 0.85 }
  }

  // Small document icon (currentColor), like the file chips in Claude Code / vPi.
  function FileIcon() {
    return h('svg', { viewBox: '0 0 16 16', width: 10, height: 10, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
      strokeLinejoin: 'round', strokeLinecap: 'round', 'aria-hidden': true, focusable: 'false', style: STYLE.icon },
      h('path', { d: 'M4 1.75h5.25L12.5 5v9.25H4z' }), h('path', { d: 'M9 1.75V5.25h3.5' }))
  }

  function IdeContextChip(props) {
    var sessionId = props.sessionId
    var stateRef = React.useState(null)
    var state = stateRef[0]
    var setState = stateRef[1]

    React.useEffect(function () {
      var alive = true
      var controller = null
      var retryTimer = null
      var pollTimer = null
      var delay = RECONNECT_MIN_MS
      function set(s) { if (alive) setState(s) }
      function connect() {
        if (!alive) return
        controller = new AbortController()
        readEvents(sessionId, controller.signal, set, function () { delay = RECONNECT_MIN_MS })
          .catch(function () { /* fall through to reconnect */ })
          .then(function () {
            if (!alive) return
            retryTimer = setTimeout(connect, delay)
            delay = Math.min(delay * 2, RECONNECT_MAX_MS)
          })
      }
      // Slow fallback: also re-follows the folder if the stream is wedged.
      function poll() {
        if (!alive) return
        var hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
        var done = function () { if (alive) pollTimer = setTimeout(poll, FALLBACK_POLL_MS) }
        if (hidden) return done()
        fetchState(sessionId).then(set, function () {}).then(done)
      }
      connect()
      pollTimer = setTimeout(poll, FALLBACK_POLL_MS)
      return function () {
        alive = false
        if (controller) controller.abort()
        if (retryTimer) clearTimeout(retryTimer)
        if (pollTimer) clearTimeout(pollTimer)
      }
    }, [sessionId])

    var v = view(state, !!sessionId)
    if (!v) return null
    var style = Object.assign({}, STYLE.base, STYLE[v.tone])
    function onClick(event) {
      event.preventDefault()
      if (!sessionId || !state) return
      postToggle(sessionId, !state.enabled).then(function (s) { if (s) setState(s) })
    }
    return h('div', { className: 'dsh-ide-context-chip-row', style: STYLE.wrap },
      h('button', {
        type: 'button', className: 'dsh-ide-context-chip', 'data-tone': v.tone, 'data-status': state.status,
        title: v.title, 'aria-label': v.title, 'aria-pressed': state.enabled, onClick: onClick, style: style
      }, h(FileIcon), h('span', { className: 'dsh-ide-context-chip-text', style: STYLE.text }, v.text)))
  }

  function apply(ctx) {
    ctx.slots.inject('conversation.input.overlay', function () {
      return ctx.slots.register({
        name: 'conversation.input.overlay',
        id: 'dsh-ide-context-chip',
        order: 50,
        inject: function (sessionId) { return { sessionId: sessionId } }
      }, IdeContextChip)
    })
  }

  exports.apply = apply
  exports.inject = ['slots']
  exports.view = view
  return module.exports
} })
