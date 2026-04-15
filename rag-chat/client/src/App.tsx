import { FormEvent, useEffect, useRef, useState } from 'react'

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

const API_BASE_URL = 'http://localhost:3001'

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)
  const transcriptRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const transcript = transcriptRef.current

    if (!transcript) {
      return
    }

    transcript.scrollTop = transcript.scrollHeight
  }, [messages, isSending])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const content = draft.trim()

    if (!content || isSending) {
      return
    }

    const userMessage: ChatMessage = { role: 'user', content }
    const nextMessages = [...messages, userMessage]

    setDraft('')
    setError(null)
    setIsSending(true)
    setMessages(nextMessages)

    try {
      const response = await fetch(`${API_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messages: nextMessages }),
      })
      const payload = (await response.json()) as
        | { message?: ChatMessage; error?: string }
        | undefined

      if (!response.ok || !payload?.message) {
        throw new Error(payload?.error || 'Chat request failed')
      }

      setMessages([...nextMessages, payload.message])
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unable to reach the chat server'
      setError(message)
    } finally {
      setIsSending(false)
    }
  }

  return (
    <main className="app-shell">
      <section className="chat-panel">
        <header className="chat-header">
          <p className="eyebrow">OpenRouter + LangChain</p>
          <h1>Simple AI Chat</h1>
          <p className="description">
            Send a prompt from the browser, let the server call the model, and
            render the reply inline.
          </p>
        </header>

        <div className="transcript" ref={transcriptRef}>
          {messages.length === 0 ? (
            <div className="empty-state">
              <p>Start with any prompt.</p>
              <p>The server expects `OPENROUTER_API_KEY` before it can reply.</p>
            </div>
          ) : null}

          {messages.map((message, index) => (
            <article
              className={`bubble ${message.role}`}
              key={`${message.role}-${index}`}
            >
              <p className="bubble-role">{message.role}</p>
              <p>{message.content}</p>
            </article>
          ))}

          {isSending ? (
            <article className="bubble assistant pending">
              <p className="bubble-role">assistant</p>
              <p>Thinking...</p>
            </article>
          ) : null}
        </div>

        {error ? <div className="error-banner">{error}</div> : null}

        <form className="composer" onSubmit={handleSubmit}>
          <label className="sr-only" htmlFor="prompt">
            Prompt
          </label>
          <textarea
            id="prompt"
            name="prompt"
            rows={3}
            placeholder="Ask anything..."
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={isSending}
          />
          <button type="submit" disabled={isSending || !draft.trim()}>
            {isSending ? 'Sending...' : 'Send'}
          </button>
        </form>
      </section>
    </main>
  )
}
