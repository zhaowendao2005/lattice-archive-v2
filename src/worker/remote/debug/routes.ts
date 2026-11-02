/**
 * ============================================================================
 * 远端调试快照与 Agent 渐进式日志查询路由 (src/worker/remote/debug/routes.ts)
 * ============================================================================
 * 路由列表：
 *   GET    /api/debug/keys          列出当前用户的 Agent 访问密钥
 *   POST   /api/debug/keys          创建新的 Agent 访问密钥（支持生命周期配置）
 *   DELETE /api/debug/keys/:id      吊销指定 Agent 访问密钥
 *   GET    /api/debug/snapshots      列出当前账号的云端日志快照元数据（不含压缩正文）
 *   PUT    /api/debug/snapshots      创建一条新的分片日志快照记录
 *   DELETE /api/debug/snapshots/:id  删除当前账号的一条快照及其全部分片
 *   PUT    /api/debug/snapshot       兼容旧版单字段快照上传
 *   GET    /api/debug/agent/query   Agent 凭密钥渐进式查询日志（支持 overview / timeline / grep / trace 与时间区间）
 */
import { AuthError } from '../auth/types';
import { requireUser } from '../shared/authGuard';
import { json } from '../shared/http';
import {
  authenticateAgentKey,
  createUserAgentKey,
  deleteUserDebugSnapshot,
  executeProgressiveAgentQuery,
  listUserAgentKeys,
  listUserDebugSnapshots,
  revokeUserAgentKey,
  saveUserDebugSnapshot,
} from './service';

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('bad body');
    return body as Record<string, unknown>;
  } catch {
    throw new AuthError('INVALID_REQUEST', '请求格式无效', 400);
  }
}

export async function handleDebugRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  try {
    // 1. Agent 免会话渐进式查询端点（凭 lat_agk_... 密钥鉴权）
    if (url.pathname === '/api/debug/agent/query' && request.method === 'GET') {
      const keyRow = await authenticateAgentKey(request, env);
      const result = await executeProgressiveAgentQuery(env, keyRow.user_id, url.searchParams);
      return json(result, 200, { 'Cache-Control': 'no-store' });
    }

    // 2. 其余管理与快照上传端点需校验登录用户会话
    const session = await requireUser(request, env);

    if (url.pathname === '/api/debug/keys') {
      if (request.method === 'GET') {
        return json(await listUserAgentKeys(env, session.user_id), 200, {
          'Cache-Control': 'no-store',
        });
      }
      if (request.method === 'POST') {
        const created = await createUserAgentKey(env, session.user_id, await bodyOf(request));
        return json(created, 201, { 'Cache-Control': 'no-store' });
      }
    }

    if (url.pathname.startsWith('/api/debug/keys/') && request.method === 'DELETE') {
      const keyId = url.pathname.slice('/api/debug/keys/'.length).trim();
      if (!keyId) throw new AuthError('INVALID_REQUEST', '缺少密钥 ID', 400);
      return json(await revokeUserAgentKey(env, session.user_id, keyId), 200, {
        'Cache-Control': 'no-store',
      });
    }

    if (url.pathname === '/api/debug/snapshots') {
      if (request.method === 'GET') {
        return json(await listUserDebugSnapshots(env, session.user_id), 200, {
          'Cache-Control': 'no-store',
        });
      }
      if (request.method === 'PUT') {
        const saved = await saveUserDebugSnapshot(env, session.user_id, await bodyOf(request));
        return json(saved, 201, { 'Cache-Control': 'no-store' });
      }
    }

    if (url.pathname.startsWith('/api/debug/snapshots/') && request.method === 'DELETE') {
      const rawSnapshotId = url.pathname.slice('/api/debug/snapshots/'.length).trim();
      let snapshotId = '';
      try {
        snapshotId = decodeURIComponent(rawSnapshotId);
      } catch {
        throw new AuthError('INVALID_REQUEST', '快照标识无效', 400);
      }
      if (!snapshotId) throw new AuthError('INVALID_REQUEST', '缺少快照标识', 400);
      return json(await deleteUserDebugSnapshot(env, session.user_id, snapshotId), 200, {
        'Cache-Control': 'no-store',
      });
    }

    // 兼容旧版单行快照上传入口；新前端统一使用 /api/debug/snapshots。
    if (url.pathname === '/api/debug/snapshot' && request.method === 'PUT') {
      const saved = await saveUserDebugSnapshot(env, session.user_id, await bodyOf(request));
      return json(saved, 201, { 'Cache-Control': 'no-store' });
    }

    return json({ error: 'NOT_FOUND', message: '接口不存在' }, 404);
  } catch (error) {
    if (error instanceof AuthError) {
      return json({ error: error.code, message: error.message }, error.status);
    }
    throw error;
  }
}
