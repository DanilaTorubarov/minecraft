import { useEffect, useId, useState, type FormEvent } from 'react'
import { ApiError, getPlayerSkin, uploadPlayerSkin, type SkinView } from '../lib/api'
import SkinFigure from '../components/SkinFigure'

export default function SkinPage({ uuid, username, visible }: { uuid: string; username: string; visible: boolean }) {
  const id = useId()
  const [skin, setSkin] = useState<SkinView | null>(null)
  const [loadError, setLoadError] = useState('')
  const [uploadError, setUploadError] = useState('')
  const [selection, setSelection] = useState<{ file: File; url: string } | null>(null)
  const [model, setModel] = useState<'classic' | 'slim'>('classic')
  const [sending, setSending] = useState(false)
  const [version, setVersion] = useState(0)
  useEffect(() => () => { if (selection) URL.revokeObjectURL(selection.url) }, [selection])
  useEffect(() => {
    if (!visible) return
    let active = true
    let pending = false
    const refresh = async () => {
      if (pending || document.visibilityState !== 'visible') return
      pending = true
      try {
        const found = await getPlayerSkin(uuid)
        if (active) { setSkin(found); setLoadError('') }
      } catch { if (active) setLoadError('Could not load this player’s skin. Try again.') }
      finally { pending = false }
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 5000)
    return () => { active = false; window.clearInterval(timer) }
  }, [uuid, visible, version])
  const busy = sending || ['queued', 'signing', 'ready'].includes(skin?.upload?.status ?? '')
  async function chooseFile(selected: File | undefined) {
    setSelection(null); setUploadError('')
    if (!selected) return
    if (selected.size > 256 * 1024 || !selected.size) { setUploadError('Choose a PNG skin smaller than 256 KB.'); return }
    try {
      const bytes = new Uint8Array(await selected.slice(0, 24).arrayBuffer())
      const view = new DataView(bytes.buffer)
      if (bytes.length < 24 || ![137,80,78,71,13,10,26,10].every((n, i) => bytes[i] === n) || view.getUint32(16) !== 64 || ![32,64].includes(view.getUint32(20))) {
        setUploadError('Use a standard 64 × 64 or 64 × 32 Minecraft PNG skin.'); return
      }
      setSelection({ file: selected, url: URL.createObjectURL(selected) })
    } catch { setUploadError('Could not read this file. Choose it again.') }
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!selection || busy) return
    setSending(true); setUploadError('')
    try {
      await uploadPlayerSkin(uuid, selection.file, model)
      setSkin((current) => ({ texture_hash: current?.texture_hash ?? null, model: current?.model ?? 'classic', observed_at: current?.observed_at ?? null, upload: { status: 'queued', error: null } }))
      setVersion((value) => value + 1)
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0
      setUploadError(status === 400 || status === 413 ? 'Use a valid 64 × 64 or 64 × 32 PNG smaller than 256 KB.' : status === 409 ? 'Another upload is still being processed.' : status === 429 ? 'Wait 30 seconds between skin uploads.' : status === 404 ? 'This player is no longer linked to your account.' : 'Could not upload the skin. Check your connection and try again.')
    } finally { setSending(false) }
  }
  const status = skin?.upload?.status
  return <>
    <div className="page-head"><h1>Skin</h1><p className="page-sub">View and change {username}’s appearance on this server.</p></div>
    {loadError && <div className="note" data-tone="error" role="alert"><p>{loadError}</p><button className="btn" onClick={() => setVersion((value) => value + 1)}>Retry loading skin</button></div>}
    <div className="skin-layout">
      <section className="skin-current" aria-labelledby={`${id}-current`}><h2 id={`${id}-current`}>Current skin</h2>
        <div className="skin-preview-well">{skin?.texture_hash ? <SkinFigure src={`https://textures.minecraft.net/texture/${skin.texture_hash}`} model={skin.model} label={`${username}’s current server skin`} /> : <p className="page-sub">{skin === null ? 'Loading current skin…' : 'The game server has not reported a skin yet. It will appear after synchronization.'}</p>}</div>
        <p className="page-sub">{username}<br />{skin?.texture_hash ? `${skin.model === 'slim' ? 'Slim' : 'Classic'} model` : 'Waiting for server skin'}</p>
      </section>
      <section className="skin-upload" aria-labelledby={`${id}-upload`}><h2 id={`${id}-upload`}>Upload a new skin</h2>
        <p className="page-sub">Choose a Minecraft skin PNG, then save it to this player. Your Microsoft or launcher account skin stays unchanged.</p>
        <form onSubmit={submit}>
          <div className="field"><label htmlFor={`${id}-file`}>Skin file</label><input id={`${id}-file`} type="file" accept="image/png,.png" disabled={busy} aria-describedby={`${id}-file-help`} onChange={(event) => { void chooseFile(event.target.files?.[0]) }} /><p className="field-help" id={`${id}-file-help`}>PNG · 64 × 64 or 64 × 32 pixels · up to 256 KB</p></div>
          <div className="field"><label htmlFor={`${id}-model`}>Arm model</label><select id={`${id}-model`} value={model} disabled={busy} onChange={(event) => setModel(event.target.value as 'classic' | 'slim')}><option value="classic">Classic — wide arms</option><option value="slim">Slim — narrow arms</option></select></div>
          {selection && <div className="skin-selected"><SkinFigure key={selection.url} src={selection.url} model={model} label="Preview of selected skin" /><div><strong>Selected skin</strong><p className="page-sub">{selection.file.name}</p></div></div>}
          <p className="field-help">Uploads are processed by MineSkin to make the skin usable in Minecraft.</p>
          {uploadError && <p className="note" data-tone="error" role="alert">{uploadError}</p>}
          <button className="btn" type="submit" disabled={!selection || busy}>{sending ? 'Uploading…' : busy ? 'Processing skin…' : 'Save skin'}</button>
        </form>
        <div role="status" aria-live="polite">
          {(status === 'queued' || status === 'signing') && <p className="note">Preparing your skin. This can take a few minutes; you can close this window and return later.</p>}
          {status === 'ready' && <p className="note">Skin prepared. Waiting for the game server to save it.</p>}
          {status === 'saved' && <p className="note" data-tone="success">Skin saved to the server. It refreshes while you’re logged in, or when you next join.</p>}
          {status === 'failed' && <p className="note" data-tone="error">{skin?.upload?.error ?? 'Could not save the skin. Upload it again.'}</p>}
        </div>
      </section>
    </div>
  </>
}
