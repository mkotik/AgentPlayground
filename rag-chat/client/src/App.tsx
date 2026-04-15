import { FormEvent, useEffect, useRef, useState } from 'react'

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
  sources?: ChatSource[]
}

type UploadTicket = {
  uploadUrl: string
  objectKey: string
  method: 'PUT'
  headers: {
    'Content-Type': string
  }
}

type ChatSource = {
  id: string
  fileId: string | null
  fileName: string
  storageKey: string | null
  chunkIndex: number | null
  score: number | null
  excerpt: string
}

type FileRecord = {
  id: string
  fileName: string
  processingStatus: string
  chunkCount: number | null
}

type RetrievalInfo = {
  query: string
  sourceCount: number
  usedContext: boolean
}

const API_BASE_URL = 'http://localhost:3001'

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retrievalInfo, setRetrievalInfo] = useState<RetrievalInfo | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const uploadInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const transcript = transcriptRef.current

    if (!transcript) {
      return
    }

    transcript.scrollTop = transcript.scrollHeight
  }, [messages, isSending])

  async function handleUploadSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!selectedFile || isUploading) {
      return
    }

    if (!selectedFile.name.toLowerCase().endsWith('.pdf')) {
      setUploadError('Only PDF files are supported.')
      return
    }

    setIsUploading(true)
    setUploadError(null)
    setUploadSuccess(null)

    try {
      const response = await fetch(`${API_BASE_URL}/api/uploads/presign`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fileName: selectedFile.name,
          contentType: selectedFile.type || 'application/pdf',
        }),
      })
      const payload = (await response.json()) as
        | ({ error?: string } & Partial<UploadTicket>)
        | undefined

      if (
        !response.ok ||
        !payload?.uploadUrl ||
        !payload.objectKey ||
        !payload.headers
      ) {
        throw new Error(payload?.error || 'Could not create an upload URL')
      }

      const uploadResponse = await fetch(payload.uploadUrl, {
        method: payload.method || 'PUT',
        headers: payload.headers,
        body: selectedFile,
      })

      if (!uploadResponse.ok) {
        throw new Error(`Upload failed with status ${uploadResponse.status}`)
      }

      const fileResponse = await fetch(`${API_BASE_URL}/api/files`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fileName: selectedFile.name,
          storageKey: payload.objectKey,
          contentType: selectedFile.type || 'application/pdf',
          sizeBytes: selectedFile.size,
          uploadStatus: 'uploaded',
          ingest: true,
        }),
      })
      const filePayload = (await fileResponse.json()) as
        | { file?: FileRecord; error?: string }
        | undefined

      if (!fileResponse.ok || !filePayload?.file) {
        throw new Error(filePayload?.error || 'Could not save uploaded file metadata')
      }

      const chunkSummary =
        typeof filePayload.file.chunkCount === 'number'
          ? ` with ${filePayload.file.chunkCount} chunks`
          : ''

      setUploadSuccess(
        `${filePayload.file.fileName} uploaded and ${filePayload.file.processingStatus}${chunkSummary}.`,
      )
      setSelectedFile(null)

      if (uploadInputRef.current) {
        uploadInputRef.current.value = ''
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unable to upload the PDF'
      setUploadError(message)
    } finally {
      setIsUploading(false)
    }
  }

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
    setRetrievalInfo(null)
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
        | { message?: ChatMessage; retrieval?: RetrievalInfo; error?: string }
        | undefined

      if (!response.ok || !payload?.message) {
        throw new Error(payload?.error || 'Chat request failed')
      }

      setRetrievalInfo(payload.retrieval || null)
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
            ground the answer with chunks retrieved from your uploaded PDFs.
          </p>
        </header>

        <section className="upload-panel">
          <div>
            <p className="upload-label">Document uploads</p>
            <p className="upload-copy">
              Choose a PDF and upload it directly to your IDrive E2 bucket. The
              server will then save the file record and ingest it into Pinecone
              synchronously.
            </p>
          </div>

          <form className="upload-form" onSubmit={handleUploadSubmit}>
            <label className="file-picker" htmlFor="pdf-upload">
              <input
                ref={uploadInputRef}
                id="pdf-upload"
                name="pdf-upload"
                type="file"
                accept="application/pdf,.pdf"
                onChange={(event) => {
                  setSelectedFile(event.target.files?.[0] ?? null)
                  setUploadError(null)
                  setUploadSuccess(null)
                }}
                disabled={isUploading}
              />
              <span>{selectedFile ? selectedFile.name : 'Select PDF'}</span>
            </label>
            <button
              className="upload-button"
              type="submit"
              disabled={!selectedFile || isUploading}
            >
              {isUploading ? 'Uploading...' : 'Upload PDF'}
            </button>
          </form>

          {uploadSuccess ? (
            <p className="upload-status success">{uploadSuccess}</p>
          ) : null}

          {uploadError ? <p className="upload-status error">{uploadError}</p> : null}
        </section>

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
              {message.role === 'assistant' && message.sources?.length ? (
                <div className="bubble-sources">
                  {message.sources.map((source) => (
                    <div key={source.id} className="source-item">
                      <p>
                        Source: {source.fileName}
                        {typeof source.chunkIndex === 'number'
                          ? `, chunk ${source.chunkIndex + 1}`
                          : ''}
                        {typeof source.score === 'number'
                          ? `, score ${source.score.toFixed(3)}`
                          : ''}
                      </p>
                      <p>{source.excerpt}</p>
                    </div>
                  ))}
                </div>
              ) : null}
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

        {retrievalInfo ? (
          <div className="retrieval-banner">
            {retrievalInfo.usedContext
              ? `Retrieved ${retrievalInfo.sourceCount} matching source${retrievalInfo.sourceCount === 1 ? '' : 's'} from Pinecone for the latest question.`
              : 'No matching document context was retrieved for the latest question.'}
          </div>
        ) : null}

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
