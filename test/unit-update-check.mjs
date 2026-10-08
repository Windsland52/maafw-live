/**
 * 更新检查的单测（headless，不打网络）。
 *
 * 钉的是三件在别处出错会很难查的事：
 *  - **版本比较**：`0.9.10 > 0.9.9`（数值比较，不是字符串）、预发布低于同号正式版；
 *  - **限频**：24h 内不重复查；缓存缺失/损坏/字段不全都当作"该查"；
 *  - **packument URL**：scoped 名只编码斜杠（`@scope` 保持字面），否则 registry 回 404。
 * 另钉一条产品约束：`MAAFW_LIVE_NO_UPDATE_CHECK` 必须能关掉自动检查。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  compareVersions, packumentUrl, shouldCheck, readState, writeState, updateCheckDisabled, UPDATE_TTL_MS,
} from '../lib/update-check.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('版本比较：数值段逐位比较（0.9.10 大于 0.9.9）', () => {
  assert.ok(compareVersions('0.9.10', '0.9.9') > 0)
  assert.ok(compareVersions('0.1.1', '0.1.0') > 0)
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
  assert.ok(compareVersions('0.1.0', '0.2.0') < 0)
  assert.equal(compareVersions('1.0', '1.0.0'), 0, '缺段补 0')
})

test('版本比较：预发布低于同号正式版', () => {
  assert.ok(compareVersions('1.0.0-rc.1', '1.0.0') < 0, 'rc < 正式')
  assert.ok(compareVersions('1.0.0', '1.0.0-rc.1') > 0)
  assert.ok(compareVersions('1.0.1-beta', '1.0.0') > 0, '主版本更高时预发布也更高')
})

test('限频：TTL 内不查，过期或缓存不可用则查', () => {
  const now = 1_700_000_000_000
  const fresh = { checkedAt: now - UPDATE_TTL_MS / 2, latest: '1.0.0' }
  const stale = { checkedAt: now - UPDATE_TTL_MS - 1, latest: '1.0.0' }
  assert.equal(shouldCheck(fresh, now), false)
  assert.equal(shouldCheck(stale, now), true)
  assert.equal(shouldCheck(null, now), true, '没缓存 → 该查')
  assert.equal(shouldCheck({ checkedAt: now, latest: '' }, now), true, '字段不完整 → 该查')
  assert.equal(shouldCheck({ checkedAt: NaN, latest: '1.0.0' }, now), true)
})

test('packument URL：scoped 名只编码斜杠', () => {
  assert.equal(packumentUrl('@windsland52/maa-live'), 'https://registry.npmjs.org/@windsland52%2Fmaa-live')
  assert.equal(packumentUrl('left-pad'), 'https://registry.npmjs.org/left-pad')
})

test('缓存读写：坏文件当作没有，不抛', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maafw-vc-'))
  const file = path.join(dir, 'version-check.json')
  try {
    assert.equal(readState(file), null, '文件不存在 → null')
    fs.writeFileSync(file, '{ 半写')
    assert.equal(readState(file), null, '坏 JSON → null')
    fs.writeFileSync(file, JSON.stringify({ checkedAt: 'x', latest: 1 }))
    assert.equal(readState(file), null, '字段类型不对 → null')
    writeState({ checkedAt: 123, latest: '0.1.1' }, file)
    assert.deepEqual(readState(file), { checkedAt: 123, latest: '0.1.1' })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('开关：MAAFW_LIVE_NO_UPDATE_CHECK 能关掉自动检查', () => {
  assert.equal(updateCheckDisabled({}), false)
  assert.equal(updateCheckDisabled({ MAAFW_LIVE_NO_UPDATE_CHECK: '1' }), true)
  assert.equal(updateCheckDisabled({ MAAFW_LIVE_NO_UPDATE_CHECK: '0' }), false, '0 视为不关')
  assert.equal(updateCheckDisabled({ MAAFW_LIVE_NO_UPDATE_CHECK: 'false' }), false)
})
