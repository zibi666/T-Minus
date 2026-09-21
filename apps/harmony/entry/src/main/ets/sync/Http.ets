// 同步请求原语（与 Android data/Api.kt + backend /api/v1 契约一致）。
// 后端已上 HTTPS（域名 sync.knowhub.chat:18443 + Let's Encrypt 公信证书），鸿蒙系统已内置信任链，无需额外配置。
// 若未来遇到 TLS 错误（2300997/2300998），先检查证书是否过期或域名/端口是否变更。
import { http } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { SERVER_BASE } from '../data/AuthStore';

const TAG = 'TimeMarkHttp';
const CONNECT_TIMEOUT_MS: number = 8000;
const READ_TIMEOUT_MS: number = 15000;

export class HttpError extends Error {
  /** 正数 = HTTP 状态码；负数 = 网络层系统错误码的相反数（鸿蒙系统错误码 401 是「参数错误」，
   *  与 HTTP 401 同值不同义，混用会误触发客户端的「清凭据」逻辑） */
  status: number;
  body: string;

  constructor(status: number, message: string, body: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function toRecord(text: string): Record<string, Object> {
  if (text.length === 0) {
    const empty: Record<string, Object> = {};
    return empty;
  }
  const parsed: Object = JSON.parse(text);
  return parsed as Record<string, Object>;
}

/** 鸿蒙网络栈常见错误码 → 可读原因（2300997 = 明文 HTTP 被系统拦截） */
function describeNetError(code: number, raw: string): string {
  if (code === 2300997) return '明文 HTTP 被系统拦截（2300997）：需为后端启用 HTTPS 或配置网络安全策略';
  if (code === 2300022 || code === 2300006) return `连不上同步服务（${code}）：请确认后端在线且地址可达`;
  if (code === 2300028) return '连接超时（2300028）：网络不可达或后端无响应';
  if (code === 2300067) return '域名不允许访问（2300067）';
  return `网络请求失败（${code}）：${raw}`;
}

async function send(method: http.RequestMethod, url: string, body: string | null,
  token: string | null): Promise<Record<string, Object>> {
  const req = http.createHttp();
  const headers: Record<string, string> = {};
  headers['Content-Type'] = 'application/json';
  if (token !== null) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const options: http.HttpRequestOptions = {
    method: method,
    header: headers,
    expectDataType: http.HttpDataType.STRING,
    connectTimeout: CONNECT_TIMEOUT_MS,
    readTimeout: READ_TIMEOUT_MS,
    usingProxy: false
  };
  if (body !== null) {
    options.extraData = body;
  }
  try {
    const resp = await req.request(url, options);
    const code: number = resp.responseCode;
    const text: string = typeof resp.result === 'string' ? (resp.result as string) : `${resp.result}`;
    if (code < 200 || code >= 300) {
      let reason = `HTTP ${code}`;
      try {
        const r = toRecord(text);
        const m = r['message'];
        if (typeof m === 'string') reason = m as string;
        const e = r['error'];
        if (typeof e === 'string') reason = e as string;
      } catch (err) {
        // 非 JSON 错误体：保留状态码
      }
      throw new HttpError(code, reason, text);
    }
    return toRecord(text);
  } catch (e) {
    const err = e as BusinessError;
    if (e instanceof HttpError) throw e;
    const code = typeof err.code === 'number' ? err.code : 0;
    // 取负数：网络层错误绝不能与 HTTP 状态码同域（系统 401≠HTTP 401）
    throw new HttpError(-code, describeNetError(code, `${e}`), '');
  } finally {
    req.destroy();
  }
}

/** base 与 path 的斜杠容错拼接：两头历史写法都没带分隔符，直接模板串拼会得出 18080api/v1/... */
function joinUrl(base: string, path: string): string {
  const b = base.endsWith('/') ? base : `${base}/`;
  const p = path.startsWith('/') ? path.substring(1) : path;
  return `${b}${p}`;
}

export function postJson(path: string, body: Object, token: string | null): Promise<Record<string, Object>> {
  return send(http.RequestMethod.POST, joinUrl(SERVER_BASE, path), JSON.stringify(body), token);
}

export function getPath(path: string, token: string | null): Promise<Record<string, Object>> {
  return send(http.RequestMethod.GET, joinUrl(SERVER_BASE, path), null, token);
}

export function logHttp(msg: string): void {
  hilog.info(0x0000, TAG, msg);
}
