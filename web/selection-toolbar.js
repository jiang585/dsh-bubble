/**
 * Selection toolbar renderer.
 *
 * Modern floating pill for text lookups, translations, and agent prompts.
 *
 * @module dsh-bubble/web/selection-toolbar
 */
(() => {
  'use strict'

  const tauri = window.__TAURI__
  const invoke = tauri?.core?.invoke
  const listen = tauri?.event?.listen

  const searchButton = document.getElementById('search')
  const translateButton = document.getElementById('translate')
  const sendButton = document.getElementById('send-to-agent')
  const closeButton = document.getElementById('close-toolbar')

  let environment = { apiBase: location.origin, token: '' }
  let selection = ''

  async function request(path, body) {
    const response = await fetch(`${environment.apiBase}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bubble-token': environment.token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`${path} -> ${response.status}`)
  }

  async function hide() {
    if (typeof invoke === 'function') await invoke('bubble_hide_toolbar')
  }

  function wire() {
    closeButton.addEventListener('click', async (e) => {
      e.stopPropagation()
      await hide()
    })

    searchButton.addEventListener('click', async () => {
      const url = `https://www.bing.com/search?q=${encodeURIComponent(selection)}`
      if (typeof invoke === 'function') await invoke('bubble_open_url', { url })
      await hide()
    })

    translateButton.addEventListener('click', async () => {
      try {
        await request('/message', {
          text: `请将以下内容翻译为中文（若为中文则翻译为英文），仅输出译文，无需额外解释：\n\n${selection}`,
        })
      } catch (error) {
        console.error('dsh-bubble: translate failed', error)
      }
      await hide()
    })

    sendButton.addEventListener('click', async () => {
      try {
        await request('/selection', { text: selection })
      } catch (error) {
        console.error('dsh-bubble: send failed', error)
      }
      await hide()
    })
  }

  async function boot() {
    wire()
    if (typeof invoke === 'function') {
      const env = await invoke('bubble_environment')
      if (env !== undefined && env !== null) {
        environment = { apiBase: env.api_base, token: env.token }
      }
    }
    if (typeof listen === 'function') {
      // `bubble:selection-ready` carries the text; `bubble:dismiss` retires the toolbar.
      await listen('bubble:selection-ready', (event) => {
        selection = String(event.payload?.text ?? '')
      })
      await listen('bubble:dismiss', () => {
        void hide()
      })
    }
  }

  void boot()
})()
