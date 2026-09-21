import React, { useState } from 'react';
import { IconClose } from './icons';

// 服务地址实际由主进程 syncClient.ts 的 DEFAULT_SERVER 决定（setServer 会忽略此传入值），
// 这里仅为占位，保持与生产地址一致以免误导（真正的单一来源在 syncClient.ts）。
const SYNC_SERVER = 'https://sync.knowhub.chat:18443';

export default function LoginModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    if (!username.trim() || !password) {
      setErr('请填写用户名和密码');
      return;
    }
    setBusy(true);
    setErr('');
    const r = mode === 'login'
      ? await window.timemark.login(SYNC_SERVER, username.trim(), password)
      : await window.timemark.register(SYNC_SERVER, username.trim(), password);
    setBusy(false);
    if (r.ok) onDone();
    else setErr(r.message || '失败');
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} title="关闭"><IconClose size={15} /></button>
        <h2>{mode === 'login' ? '登录同步账号' : '注册同步账号'}</h2>
        <div className="field">
          <label>用户名</label>
          <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" maxLength={50} autoFocus />
        </div>
        <div className="field">
          <label>密码{mode === 'register' ? '（至少 6 位）' : ''}</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="password"
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          />
        </div>
        {err && <div className="err-text">{err}</div>}
        <div className="modal-actions">
          <button onClick={onClose}><span>取消</span></button>
          <button className="primary" disabled={busy} onClick={submit}><span>{busy ? '请稍候…' : mode === 'login' ? '登录' : '注册并登录'}</span></button>
        </div>
        <div className="server-hint">
          {mode === 'login' ? '还没有账号？' : '已有账号？'}
          <button className="link" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setErr(''); }}>
            {mode === 'login' ? '注册一个' : '去登录'}
          </button>
          ・登录后数据自动多端同步；不登录也可以正常本地使用。
        </div>
      </div>
    </div>
  );
}
