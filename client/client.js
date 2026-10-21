// dsh-ide-context client half (ModuleLoader format, hand-written ES5-ish JS,
// no build step): a small chip at the left of the composer footer showing which
// IDE selection the next turn will carry, with a click to switch the IDE
// reading off/on for this session. It polls the host route; the browser never
// talks to the IDE, so the single server-side IDE connection is shared.
window.__ModuleLoader__.load({ id: '@deepseek-ai/dsh-ide-context', factory: function (require) {
  var module = { exports: {} }
  var exports = module.exports
  var React = require('react')
  var h = React.createElement

  var ROUTE = '/ide-context/api'
  var POLL_MS = 1500
  var HEADERS = { 'x-dsh-ide-context': '1' }

  function fetchState(sessionId) {
    var q = sessionId ? '?session=' + encodeURIComponent(sessionId) : ''
    return fetch(ROUTE + '/state' + q, { headers: HEADERS, credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (body) { return body && body.ok ? body.value : null })
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
      display: 'inline-flex', alignItems: 'center', gap: '4px', maxWidth: '260px', height: '24px',
      padding: '0 8px', borderRadius: '12px', border: '1px solid', fontSize: '12px', lineHeight: '22px',
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
      var timer = null
      function tick() {
        if (!alive) return
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
          timer = setTimeout(tick, POLL_MS)
          return
        }
        fetchState(sessionId).then(function (s) { if (alive) setState(s) }, function () { if (alive) setState(null) })
          .then(function () { if (alive) timer = setTimeout(tick, POLL_MS) })
      }
      tick()
      return function () { alive = false; if (timer) clearTimeout(timer) }
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
