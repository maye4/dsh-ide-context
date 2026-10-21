// dsh-ide-context client half (ModuleLoader format, hand-written ES5-ish JS,
// no build step): a small chip at the left of the composer footer showing which
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

  var STYLE = {
    base: {
      display: 'inline-flex', alignItems: 'center', gap: '3px', maxWidth: '200px', height: '18px',
      padding: '0 4px', borderRadius: '5px', border: '0.5px solid', fontSize: '11px', lineHeight: '17px',
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'pointer',
      background: 'transparent', fontFamily: 'inherit', flexShrink: 1, minWidth: 0
    },
    on: { borderColor: 'rgba(59,130,246,0.55)', color: 'rgb(37,99,235)', background: 'rgba(59,130,246,0.08)' },
    sent: { borderColor: 'rgba(128,128,128,0.35)', color: 'inherit', opacity: 0.8 },
    muted: { borderColor: 'rgba(128,128,128,0.3)', color: 'inherit', opacity: 0.55 },
    off: { borderColor: 'rgba(220,38,38,0.45)', color: 'rgb(220,38,38)', opacity: 0.85 }
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
    return h('button', {
      type: 'button', className: 'dsh-ide-context-chip', 'data-tone': v.tone, 'data-status': state.status,
      title: v.title, 'aria-label': v.title, 'aria-pressed': state.enabled, onClick: onClick, style: style
    }, h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, v.text))
  }

  function apply(ctx) {
    ctx.slots.inject('conversation.input.left', function () {
      return ctx.slots.register({
        name: 'conversation.input.left',
        id: 'dsh-ide-context-chip',
        order: 5,
        inject: function (sessionId) { return { sessionId: sessionId } }
      }, IdeContextChip)
    })
  }

  exports.apply = apply
  exports.inject = ['slots']
  exports.view = view
  return module.exports
} })
