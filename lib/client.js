/**
 * dsh-shot-analyzer — client half.
 *
 * One compact control in the composer tool row. Pressing it asks the host half
 * for a screenshot of the desktop; the host stores it and posts it into the
 * current Session as a user prompt, so the Agent analyzes the picture and
 * answers in the conversation.
 */
window.__ModuleLoader__.load({
	id: 'dsh-shot-analyzer',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		var React = require('react')

		/** Same-origin host route that captures and delivers. */
		var CAPTURE_URL = '/dsh-shot/capture'

		/** How long a settled status stays on screen before the control goes quiet again. */
		var RESET_MS = 6000

		var COLORS = {
			idle: 'var(--dsw-alias-label-secondary)',
			busy: 'var(--dsw-alias-brand-primary)',
			ok: 'var(--dsw-alias-state-success-primary)',
			error: 'var(--dsw-alias-state-error-primary)',
		}

		function statusLabel(state) {
			if (state.phase === 'busy') return state.text || '截图…'
			if (state.phase === 'ok') return state.text || '已发送'
			if (state.phase === 'error') return '失败'
			return ''
		}

		function ShotButton(props) {
			var sessionId = props && props.sessionId
			var pair = React.useState({ phase: 'idle', text: '', detail: '' })
			var status = pair[0]
			var setStatus = pair[1]
			var busy = status.phase === 'busy'

			React.useEffect(function () {
				if (status.phase === 'idle' || status.phase === 'busy') return undefined
				var timer = window.setTimeout(function () {
					setStatus({ phase: 'idle', text: '', detail: '' })
				}, RESET_MS)
				return function () { window.clearTimeout(timer) }
			}, [status])

			var onClick = React.useCallback(function () {
				if (busy) return
				if (!sessionId) {
					setStatus({ phase: 'error', text: '失败', detail: '当前没有会话，无法把截图发出去' })
					return
				}
				setStatus({ phase: 'busy', text: '截图…', detail: '' })
				window.fetch(CAPTURE_URL, {
					method: 'POST',
					cache: 'no-store',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ sessionId: sessionId }),
				}).then(function (response) {
					return response.json().catch(function () {
						return { ok: false, error: 'HTTP ' + response.status }
					})
				}).then(function (data) {
					if (data && data.ok) {
						var size = data.width && data.height ? ' ' + data.width + '×' + data.height : ''
						setStatus(data.delivered
							? { phase: 'ok', text: '已发送', detail: '截图' + size + ' 已发到当前会话，正在分析' }
							: { phase: 'ok', text: '已截图', detail: (data.warning || '截图已保存') + size })
						return
					}
					var message = (data && data.error) || '截图失败'
					setStatus({ phase: 'error', text: '失败', detail: message })
				}).catch(function (error) {
					setStatus({ phase: 'error', text: '失败', detail: String((error && error.message) || error) })
				})
			}, [busy, sessionId])

			var label = statusLabel(status)
			var title = status.detail
				|| '截图分析：抓取当前屏幕并让本会话的 Agent 分析这张图'

			return React.createElement(
				'button',
				{
					type: 'button',
					onClick: onClick,
					disabled: busy,
					title: title,
					'aria-label': '截图分析',
					style: {
						display: 'inline-flex',
						alignItems: 'center',
						gap: '4px',
						height: '26px',
						padding: '0 8px',
						border: '1px solid transparent',
						borderRadius: '6px',
						background: 'transparent',
						color: COLORS[status.phase] || COLORS.idle,
						font: 'inherit',
						fontSize: '12px',
						lineHeight: 1,
						cursor: busy ? 'progress' : 'pointer',
						opacity: busy ? 0.7 : 1,
						whiteSpace: 'nowrap',
					},
				},
				React.createElement('span', { style: { fontSize: '14px', lineHeight: 1 } }, busy ? '⏳' : '📷'),
				label ? React.createElement('span', null, label) : null,
			)
		}

		/** Services this client half needs before it can register anything. */
		var inject = ['slots']

		function apply(ctx) {
			ctx.slots.inject('conversation.input.right', function () {
				return ctx.slots.register({
					name: 'conversation.input.right',
					id: 'dsh-shot',
					order: 40,
					label: '截图分析',
				}, ShotButton)
			})
		}

		exports.apply = apply
		exports.inject = inject
		exports.default = { name: 'dsh-shot-analyzer-client', inject: inject, apply: apply }
		return module.exports
	},
})
