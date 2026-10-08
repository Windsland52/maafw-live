#!/usr/bin/env node
/**
 * 沉默桩 daemon：读 stdin 但**从不回执**，用来验证客户端对"对方不回 init"的处理。
 *
 * 这不是假想场景：协议文档说 daemon 是给任何宿主复用的，客户端可以指到别的实现
 * （`SpawnOptions.daemonPath` / `MAA_DAEMON`）——那种实现若没实现 init 应答，
 * 客户端必须如实回报"init 无应答"并留下痕迹，而不是静默丢弃回执、让宿主以为一切正常。
 * 进程保持存活到 stdin 关闭，免得"对方已退出"掩盖了"对方没应答"这条判据。
 */
import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', () => { /* 故意什么都不做 */ })
rl.on('close', () => process.exit(0))
