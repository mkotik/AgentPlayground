import { FormEvent, useEffect, useState } from 'react'
import './App.css'

type Note = {
  id: number
  content: string
  created_at: string
  updated_at: string
}

type SearchResult = {
  query: string
  score: number
  note: Note
}

const emptyError = ''
const emptySearchError = ''

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function formatScore(value: number) {
  return value.toFixed(3)
}

function App() {
  const [notes, setNotes] = useState<Note[]>([])
  const [draft, setDraft] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editingValue, setEditingValue] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isSearching, setIsSearching] = useState(false)
  const [error, setError] = useState(emptyError)
  const [searchError, setSearchError] = useState(emptySearchError)

  async function loadNotes() {
    setIsLoading(true)
    setError(emptyError)

    try {
      const response = await fetch('/api/notes')

      if (!response.ok) {
        throw new Error('Failed to load notes.')
      }

      const nextNotes: Note[] = await response.json()
      setNotes(nextNotes)
    } catch (loadError) {
      console.error(loadError)
      setError('Unable to load notes right now.')
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    void loadNotes()
  }, [])

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const content = draft.trim()

    if (!content) {
      setError('Enter a note before saving.')
      return
    }

    setIsSaving(true)
    setError(emptyError)

    try {
      const response = await fetch('/api/notes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content }),
      })

      if (!response.ok) {
        throw new Error('Failed to create note.')
      }

      const createdNote: Note = await response.json()
      setNotes((currentNotes) => [createdNote, ...currentNotes])
      setDraft('')
    } catch (createError) {
      console.error(createError)
      setError('Unable to save the note.')
    } finally {
      setIsSaving(false)
    }
  }

  function beginEdit(note: Note) {
    setEditingId(note.id)
    setEditingValue(note.content)
    setError(emptyError)
  }

  function cancelEdit() {
    setEditingId(null)
    setEditingValue('')
  }

  async function handleUpdate(noteId: number) {
    const content = editingValue.trim()

    if (!content) {
      setError('A note cannot be empty.')
      return
    }

    setIsSaving(true)
    setError(emptyError)

    try {
      const response = await fetch(`/api/notes/${noteId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content }),
      })

      if (!response.ok) {
        throw new Error('Failed to update note.')
      }

      const updatedNote: Note = await response.json()

      setNotes((currentNotes) =>
        currentNotes.map((note) => (note.id === noteId ? updatedNote : note)),
      )
      cancelEdit()
    } catch (updateError) {
      console.error(updateError)
      setError('Unable to update the note.')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleDelete(noteId: number) {
    setIsSaving(true)
    setError(emptyError)

    try {
      const response = await fetch(`/api/notes/${noteId}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        throw new Error('Failed to delete note.')
      }

      setNotes((currentNotes) =>
        currentNotes.filter((note) => note.id !== noteId),
      )

      if (editingId === noteId) {
        cancelEdit()
      }
    } catch (deleteError) {
      console.error(deleteError)
      setError('Unable to delete the note.')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const query = searchQuery.trim()

    if (!query) {
      setSearchError('Enter a string to search for a similar note.')
      return
    }

    setIsSearching(true)
    setSearchError(emptySearchError)

    try {
      const response = await fetch('/api/notes/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      })

      if (response.status === 404) {
        setSearchResult(null)
        setSearchError('No similar notes were found yet.')
        return
      }

      if (response.status === 503) {
        setSearchResult(null)
        setSearchError('Semantic search is not configured on the server.')
        return
      }

      if (!response.ok) {
        throw new Error('Failed to search notes.')
      }

      const nextResult: SearchResult = await response.json()
      setSearchResult(nextResult)
    } catch (searchRequestError) {
      console.error(searchRequestError)
      setSearchResult(null)
      setSearchError('Unable to search notes right now.')
    } finally {
      setIsSearching(false)
    }
  }

  return (
    <main className="app-shell">
      <section className="notes-panel">
        <div className="notes-header">
          <div>
            <p className="eyebrow">Postgres Notes</p>
            <h1>Agent Playground</h1>
          </div>
          <p className="copy">
            Create, review, update, and delete notes backed by your server API.
          </p>
        </div>

        <form className="composer" onSubmit={handleCreate}>
          <label className="label" htmlFor="new-note">
            New note
          </label>
          <textarea
            id="new-note"
            className="textarea"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Write something worth keeping."
            rows={4}
          />
          <div className="composer-actions">
            <button className="primary-button" type="submit" disabled={isSaving}>
              {isSaving ? 'Saving...' : 'Add note'}
            </button>
          </div>
        </form>

        {error ? <p className="error-banner">{error}</p> : null}

        <section className="search-panel">
          <div className="notes-list-header">
            <div>
              <h2>Semantic search</h2>
              <p className="search-copy">
                Enter a string and retrieve the stored note that is most similar.
              </p>
            </div>
          </div>

          <form className="search-form" onSubmit={handleSearch}>
            <label className="label" htmlFor="semantic-search">
              Search string
            </label>
            <input
              id="semantic-search"
              className="search-input"
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="e.g. product launch checklist"
            />
            <button
              className="primary-button"
              type="submit"
              disabled={isSearching}
            >
              {isSearching ? 'Searching...' : 'Find closest note'}
            </button>
          </form>

          {searchError ? <p className="error-banner">{searchError}</p> : null}

          {searchResult ? (
            <article className="search-result">
              <div className="note-meta">
                <span>Best match for "{searchResult.query}"</span>
                <span>Similarity {formatScore(searchResult.score)}</span>
              </div>
              <p className="note-content">{searchResult.note.content}</p>
              <div className="note-meta">
                <span>Updated {formatDate(searchResult.note.updated_at)}</span>
                <span>Created {formatDate(searchResult.note.created_at)}</span>
              </div>
            </article>
          ) : null}
        </section>

        <section className="notes-list" aria-live="polite">
          <div className="notes-list-header">
            <h2>All notes</h2>
            <button
              className="secondary-button"
              type="button"
              onClick={() => void loadNotes()}
              disabled={isLoading || isSaving}
            >
              Refresh
            </button>
          </div>

          {isLoading ? <p className="empty-state">Loading notes...</p> : null}

          {!isLoading && notes.length === 0 ? (
            <p className="empty-state">No notes yet. Add the first one above.</p>
          ) : null}

          {!isLoading
            ? notes.map((note) => {
                const isEditing = editingId === note.id

                return (
                  <article className="note-card" key={note.id}>
                    <div className="note-meta">
                      <span>Updated {formatDate(note.updated_at)}</span>
                      <span>Created {formatDate(note.created_at)}</span>
                    </div>

                    {isEditing ? (
                      <>
                        <textarea
                          className="textarea"
                          value={editingValue}
                          onChange={(event) => setEditingValue(event.target.value)}
                          rows={4}
                        />
                        <div className="note-actions">
                          <button
                            className="primary-button"
                            type="button"
                            onClick={() => void handleUpdate(note.id)}
                            disabled={isSaving}
                          >
                            Save
                          </button>
                          <button
                            className="secondary-button"
                            type="button"
                            onClick={cancelEdit}
                            disabled={isSaving}
                          >
                            Cancel
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <p className="note-content">{note.content}</p>
                        <div className="note-actions">
                          <button
                            className="secondary-button"
                            type="button"
                            onClick={() => beginEdit(note)}
                            disabled={isSaving}
                          >
                            Edit
                          </button>
                          <button
                            className="danger-button"
                            type="button"
                            onClick={() => void handleDelete(note.id)}
                            disabled={isSaving}
                          >
                            Delete
                          </button>
                        </div>
                      </>
                    )}
                  </article>
                )
              })
            : null}
        </section>
      </section>
    </main>
  )
}

export default App
