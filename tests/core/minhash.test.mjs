// P1-1 回归：MinHash 估计准、LSH 能召回近重复、且不把无关卡凑成候选。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mix32, minhashSignature, jaccardEstimate, lshBandKeys, lshCandidates } from '../../src/core/minhash.js'
import { ensureVault, writeCard } from '../../src/core/vault.js'
import { closeAllDb } from '../../src/core/db.js'

test('mix32：确定、32 位、不同 seed 不同结果', () => {
  assert.equal(mix32(12345, 0), mix32(12345, 0))
  assert.notEqual(mix32(12345, 0), mix32(12345, 1))
  for (const x of [0, 1, 1e9, 0xffffffff]) assert.ok(mix32(x, 7) >= 0 && mix32(x, 7) <= 0xffffffff)
})

test('minhashSignature：同集合签名相同，估计值接近真实 Jaccard', () => {
  const a = new Set(Array.from({ length: 300 }, (_, i) => i))
  const b = new Set(Array.from({ length: 300 }, (_, i) => i + 150)) // 交集 150 → J = 150/450 = 0.333
  const c = new Set(Array.from({ length: 300 }, (_, i) => i + 5000)) // 无交集
  const sa = minhashSignature(a, 256)
  const sb = minhashSignature(b, 256)
  const sc = minhashSignature(c, 256)
  assert.deepEqual([...minhashSignature(a, 256)], [...sa], '同集合签名必须稳定')
  assert.equal(jaccardEstimate(sa, sc), 0, '无交集估计应为 0')
  const est = jaccardEstimate(sa, sb)
  assert.ok(Math.abs(est - 0.333) < 0.08, '估计值应接近 0.333，实测 ' + est.toFixed(3))
})

test('lshBandKeys / lshCandidates：近重复进候选、无关卡不进', () => {
  assert.equal(lshBandKeys(new Uint32Array(8).fill(1), 4, 2).length, 4)
  const base = Array.from({ length: 400 }, (_, i) => i)
  const near = [...base.slice(0, 360), 9001, 9002]     // 与 base 极像
  const far = Array.from({ length: 400 }, (_, i) => i + 100000)
  const sigs = new Map([
    ['base', minhashSignature(base, 48)],
    ['near', minhashSignature(near, 48)],
    ['far', minhashSignature(far, 48)],
  ])
  const cands = lshCandidates(sigs, { bands: 24, rows: 2, maxPerCard: 10 })
  assert.ok((cands.get('base') || []).includes('near'), '近重复必须成为候选')
  assert.ok(!(cands.get('base') || []).includes('far'), '无关卡不该成为候选')
  assert.ok((cands.get('near') || []).includes('base'), '候选应双向')
})

