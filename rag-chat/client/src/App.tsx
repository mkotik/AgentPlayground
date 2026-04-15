import { useEffect, useState } from 'react'

type ApiResponse = {
  message: string
  timestamp: string
}

export default function App() {
  const [data, setData] = useState<ApiResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/health')
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`)
        }

        return response.json() as Promise<ApiResponse>
      })
      .then(setData)
      .catch((err: Error) => {
        setError(err.message)
      })
  }, [])

  return (
    <main className="app-shell">
      <section className="card">
        <p className="eyebrow">Client</p>
        <h1>React + Vite</h1>
        <p className="description">
          This page fetches a health check from the local REST API when it loads.
        </p>

        {data ? (
          <div className="result ok">
            <p>Server response: {data.message}</p>
            <p>Timestamp: {new Date(data.timestamp).toLocaleString()}</p>
          </div>
        ) : null}

        {error ? (
          <div className="result error">
            <p>Could not reach the API.</p>
            <p>{error}</p>
          </div>
        ) : null}

        {!data && !error ? <p className="loading">Checking API...</p> : null}
      </section>
    </main>
  )
}
