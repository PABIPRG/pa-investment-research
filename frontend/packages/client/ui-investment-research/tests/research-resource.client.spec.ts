import { afterEach, describe, expect, it, vi } from 'vitest'
import { createResearchResourceStore } from '../src/client/research-resource.ts'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('createResearchResourceStore', () => {
  it('shares one in-flight loader for concurrent reads of the exact same key', async () => {
    const store = createResearchResourceStore()
    const pending = deferred<{ price: number, as_of: string }>()
    const load = vi.fn(() => pending.promise)

    const first = store.read('quote:{"code":"600519"}', load)
    const second = store.read('quote:{"code":"600519"}', load)

    expect(first).toBe(second)
    expect(load).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot('quote:{"code":"600519"}')).toEqual({
      phase: 'preparing', error: '',
    })

    pending.resolve({ price: 1_600, as_of: '2026-08-31T09:30:00+08:00' })

    await expect(first).resolves.toEqual({ price: 1_600, as_of: '2026-08-31T09:30:00+08:00' })
    await expect(second).resolves.toEqual({ price: 1_600, as_of: '2026-08-31T09:30:00+08:00' })
    expect(store.getSnapshot('quote:{"code":"600519"}')).toEqual({
      phase: 'ready',
      value: { price: 1_600, as_of: '2026-08-31T09:30:00+08:00' },
      error: '',
      asOf: '2026-08-31T09:30:00+08:00',
    })
  })

  it('revalidates a ready value in the background and shares one warm flight', async () => {
    const store = createResearchResourceStore()
    const cached = { payload: 'old', as_of: '2026-08-31T03:00:00Z' }
    const refreshed = { payload: 'new', as_of: '2026-09-01T03:00:00Z' }
    await store.read('warm', async () => cached)
    const pending = deferred<typeof refreshed>()
    const load = vi.fn(() => pending.promise)

    const first = store.revalidate('warm', load)
    const second = store.revalidate('warm', load)

    expect(first).toBe(second)
    expect(load).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot('warm')).toEqual({
      phase: 'refreshing', value: cached, error: '', asOf: '2026-08-31T03:00:00Z',
    })

    pending.resolve(refreshed)
    await expect(first).resolves.toEqual(refreshed)
    expect(store.getSnapshot('warm')).toEqual({
      phase: 'ready', value: refreshed, error: '', asOf: '2026-09-01T03:00:00Z',
    })
  })

  it('keeps the ready value and its original fact time when revalidation fails', async () => {
    const store = createResearchResourceStore()
    const cached = { payload: 'old', as_of: '2026-08-31T03:00:00Z' }
    await store.read('warm', async () => cached)

    await expect(store.revalidate('warm', async () => {
      throw new Error('background refresh failed')
    })).rejects.toThrow('background refresh failed')

    expect(store.getSnapshot('warm')).toEqual({
      phase: 'stale', value: cached, error: 'background refresh failed',
      asOf: '2026-08-31T03:00:00Z',
    })
  })

  it('registers the flight before a preparing listener synchronously re-enters read', async () => {
    const store = createResearchResourceStore()
    const pending = deferred<string>()
    const load = vi.fn(() => pending.promise)
    let nested: Promise<string> | undefined
    let publications = 0
    store.subscribe('A', () => {
      publications += 1
      if (publications === 1) nested = store.read('A', load)
    })

    const outer = store.read('A', load)

    expect(publications).toBe(1)
    expect(load).toHaveBeenCalledTimes(1)
    expect(nested).toBe(outer)
    pending.resolve('value')
    await expect(outer).resolves.toBe('value')
  })

  it('registers the flight before the loader synchronously re-enters read', async () => {
    const store = createResearchResourceStore()
    const pending = deferred<string>()
    let nested: Promise<string> | undefined
    let calls = 0
    const load = vi.fn(() => {
      calls += 1
      if (calls === 1) nested = store.read('A', load)
      return pending.promise
    })

    const outer = store.read('A', load)

    expect(load).toHaveBeenCalledTimes(1)
    expect(nested).toBe(outer)
    pending.resolve('value')
    await expect(outer).resolves.toBe('value')
  })

  it('rejects a loader that directly returns its own re-entered flight and remains retryable', async () => {
    const store = createResearchResourceStore()
    let coldOutcome: unknown = 'pending'
    const coldFlight = store.read<string>('A', () => store.read('A', async () => 'nested'))
    void coldFlight.catch(reason => { coldOutcome = reason })

    await Promise.resolve()

    expect(coldOutcome).toBeInstanceOf(Error)
    expect((coldOutcome as Error).message).toBe('Research resource loader returned its own flight')
    expect(store.getSnapshot('A')).toEqual({
      phase: 'unavailable', error: 'Research resource loader returned its own flight',
    })
    await expect(store.read('A', async () => 'recovered')).resolves.toBe('recovered')

    store.invalidate('A')
    let warmOutcome: unknown = 'pending'
    const warmFlight = store.read<string>('A', () => store.read('A', async () => 'nested'))
    void warmFlight.catch(reason => { warmOutcome = reason })

    await Promise.resolve()

    expect(warmOutcome).toBeInstanceOf(Error)
    expect(store.getSnapshot('A')).toEqual({
      phase: 'stale', value: 'recovered',
      error: 'Research resource loader returned its own flight',
    })
    await expect(store.read('A', async () => 'recovered-again')).resolves.toBe('recovered-again')
  })

  it('isolates values and listeners by the complete key while reusing an A flight across A-B-A', async () => {
    const store = createResearchResourceStore()
    const keyA = '{"operation":"security.quote","code":"A"}'
    const keyB = '{"operation":"security.quote","code":"B"}'
    const pendingA = deferred<string>()
    const pendingB = deferred<string>()
    const loadA = vi.fn(() => pendingA.promise)
    const loadB = vi.fn(() => pendingB.promise)
    const listenerA = vi.fn()
    const listenerB = vi.fn()
    store.subscribe(keyA, listenerA)
    store.subscribe(keyB, listenerB)

    const firstA = store.read(keyA, loadA)
    const onlyB = store.read(keyB, loadB)
    const secondA = store.read(keyA, loadA)
    const bNotificationsBeforeASettles = listenerB.mock.calls.length

    expect(firstA).toBe(secondA)
    expect(loadA).toHaveBeenCalledTimes(1)
    pendingA.resolve('A-value')
    await expect(firstA).resolves.toBe('A-value')

    expect(store.peek(keyA)).toBe('A-value')
    expect(store.peek(keyB)).toBeUndefined()
    expect(listenerB).toHaveBeenCalledTimes(bNotificationsBeforeASettles)

    pendingB.resolve('B-value')
    await expect(onlyB).resolves.toBe('B-value')
    expect(store.peek(keyA)).toBe('A-value')
    expect(store.peek(keyB)).toBe('B-value')
    expect(listenerA).toHaveBeenCalledTimes(2)
    expect(listenerB).toHaveBeenCalledTimes(2)
  })

  it('uses getSnapshot, peek, subscribe, and cached read as LRU touches', async () => {
    const store = createResearchResourceStore()
    const key = (index: number) => `security:${index}`
    for (let index = 0; index < 20; index += 1) {
      await store.read(key(index), async () => index)
    }

    store.getSnapshot(key(0))
    store.peek(key(1))
    const unsubscribe = store.subscribe(key(2), () => {})
    unsubscribe()
    await store.read(key(3), async () => -1)
    await store.read(key(20), async () => 20)

    expect(store.peek(key(4))).toBeUndefined()
    expect(store.peek(key(0))).toBe(0)
    expect(store.peek(key(1))).toBe(1)
    expect(store.peek(key(2))).toBe(2)
    expect(store.peek(key(3))).toBe(3)
    expect(store.peek(key(20))).toBe(20)
  })

  it('never evicts an in-flight entry and converges to the limit after a flight settles', async () => {
    const store = createResearchResourceStore(1)
    const pendingA = deferred<string>()
    const pendingB = deferred<string>()
    const flightA = store.read('A', () => pendingA.promise)
    const flightB = store.read('B', () => pendingB.promise)

    pendingA.resolve('oldest-flight')
    await expect(flightA).resolves.toBe('oldest-flight')
    expect(store.peek('A')).toBeUndefined()

    pendingB.resolve('newest-flight')
    await expect(flightB).resolves.toBe('newest-flight')
    expect(store.peek('B')).toBe('newest-flight')
  })

  it('keeps subscriptions connected when their cache entry is evicted and later rebuilt', async () => {
    const store = createResearchResourceStore(1)
    const listener = vi.fn()
    const unsubscribe = store.subscribe('A', listener)
    await store.read('A', async () => 'first-A')
    const beforeEviction = listener.mock.calls.length

    await store.read('B', async () => 'only-B')
    expect(store.peek('A')).toBeUndefined()
    await store.read('A', async () => 'rebuilt-A')

    expect(listener).toHaveBeenCalledTimes(beforeEviction + 2)
    expect(store.peek('B')).toBeUndefined()
    expect(store.peek('A')).toBe('rebuilt-A')

    unsubscribe()
    const beforeUnsubscribedUpdate = listener.mock.calls.length
    store.invalidate('A')
    await store.read('A', async () => 'after-unsubscribe')
    expect(listener).toHaveBeenCalledTimes(beforeUnsubscribedUpdate)
  })

  it('makes an old unsubscriber idempotent without deleting a replacement registry for the same key', async () => {
    const store = createResearchResourceStore()
    const oldListener = vi.fn()
    const newListener = vi.fn()
    const unsubscribeOld = store.subscribe('A', oldListener)

    unsubscribeOld()
    const unsubscribeNew = store.subscribe('A', newListener)
    unsubscribeOld()
    await store.read('A', async () => 'value')

    expect(oldListener).not.toHaveBeenCalled()
    expect(newListener).toHaveBeenCalledTimes(2)

    unsubscribeNew()
    const beforeUnsubscribedUpdate = newListener.mock.calls.length
    store.invalidate('A')
    await store.read('A', async () => 'new-value')
    expect(newListener).toHaveBeenCalledTimes(beforeUnsubscribedUpdate)
  })

  it('lets an invalidated flight resolve for its caller without publishing into the new generation', async () => {
    const store = createResearchResourceStore()
    const oldPending = deferred<string>()
    const newPending = deferred<string>()
    const listener = vi.fn()
    store.subscribe('A', listener)

    const oldFlight = store.read('A', () => oldPending.promise)
    store.invalidate('A')
    const newFlight = store.read('A', () => newPending.promise)
    const notificationsBeforeOldSettles = listener.mock.calls.length

    oldPending.resolve('old-generation')
    await expect(oldFlight).resolves.toBe('old-generation')
    expect(listener).toHaveBeenCalledTimes(notificationsBeforeOldSettles)
    expect(store.getSnapshot('A')).toEqual({ phase: 'preparing', error: '' })

    newPending.resolve('new-generation')
    await expect(newFlight).resolves.toBe('new-generation')
    expect(store.peek('A')).toBe('new-generation')
    expect(listener).toHaveBeenCalledTimes(notificationsBeforeOldSettles + 1)
  })

  it('uses only service timestamps and preserves the last real timestamp through refreshes', async () => {
    const store = createResearchResourceStore()
    await store.read('snake', async () => ({ value: 1, as_of: '2026-08-31T01:00:00Z' }))
    await store.read('camel', async () => ({ value: 2, asOf: '2026-08-31T02:00:00Z' }))
    await store.read('missing', async () => ({ value: 3 }))

    expect(store.getSnapshot('snake').asOf).toBe('2026-08-31T01:00:00Z')
    expect(store.getSnapshot('camel').asOf).toBe('2026-08-31T02:00:00Z')
    expect(store.getSnapshot('missing')).not.toHaveProperty('asOf')

    store.invalidate('snake')
    await store.read('snake', async () => ({ value: 4 }))
    expect(store.getSnapshot('snake')).toEqual({
      phase: 'ready', value: { value: 4 }, error: '', asOf: '2026-08-31T01:00:00Z',
    })
  })

  it('publishes unavailable for an initial error and stale with the service timestamp when refresh fails', async () => {
    const store = createResearchResourceStore()

    await expect(store.read('cold', () => { throw new Error('offline') })).rejects.toThrow('offline')
    expect(store.getSnapshot('cold')).toEqual({ phase: 'unavailable', error: 'offline' })

    const cached = { payload: 'cached-value', as_of: '2026-08-31T03:00:00Z' }
    await store.read('warm', async () => cached)
    store.invalidate('warm')
    expect(store.getSnapshot('warm')).toEqual({
      phase: 'stale', value: cached, error: '', asOf: '2026-08-31T03:00:00Z',
    })

    const refresh = store.read('warm', async () => { throw 'refresh failed' })
    expect(store.getSnapshot('warm')).toEqual({
      phase: 'refreshing', value: cached, error: '', asOf: '2026-08-31T03:00:00Z',
    })
    await expect(refresh).rejects.toBe('refresh failed')
    expect(store.getSnapshot('warm')).toEqual({
      phase: 'stale', value: cached, error: 'refresh failed', asOf: '2026-08-31T03:00:00Z',
    })
  })

  it('formats hostile rejection values safely and always releases the failed flight', async () => {
    const store = createResearchResourceStore(1)
    const hostile = Object.create(null) as { [Symbol.toPrimitive]?: () => never }
    hostile[Symbol.toPrimitive] = () => { throw new Error('cannot stringify') }

    await expect(store.read('A', async () => { throw hostile })).rejects.toBe(hostile)
    expect(store.getSnapshot('A')).toEqual({ phase: 'unavailable', error: 'Unknown error' })

    await store.read('B', async () => 'B-value')
    expect(store.peek('A')).toBeUndefined()
    expect(store.peek('B')).toBe('B-value')
  })

  it.each([
    ['undefined', undefined],
    ['object', { detail: 'not a message' }],
    ['symbol', Symbol('not a message')],
    ['empty string', ''],
  ])('projects an Error with %s own message to a safe string and releases its flight', async (_label, message) => {
    const store = createResearchResourceStore(1)
    const reason = new Error('seed')
    Object.defineProperty(reason, 'message', { configurable: true, value: message })

    await expect(store.read('A', async () => { throw reason })).rejects.toBe(reason)
    expect(store.getSnapshot('A')).toEqual({ phase: 'unavailable', error: 'Unknown error' })
    expect(typeof store.getSnapshot('A').error).toBe('string')

    await expect(store.read('A', async () => 'recovered')).resolves.toBe('recovered')
    await store.read('B', async () => 'B-value')
    expect(store.peek('A')).toBeUndefined()
    expect(store.peek('B')).toBe('B-value')
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -2])(
    'normalizes invalid limit %s to the finite default capacity',
    async invalidLimit => {
      const store = createResearchResourceStore(invalidLimit)
      for (let index = 0; index < 21; index += 1) {
        await store.read(`key:${index}`, async () => index)
      }

      expect(store.peek('key:0')).toBeUndefined()
      expect(store.peek('key:1')).toBe(1)
      expect(store.peek('key:20')).toBe(20)
    },
  )

  it('floors a positive fractional limit to a finite positive integer', async () => {
    const store = createResearchResourceStore(2.9)
    await store.read('A', async () => 'A')
    await store.read('B', async () => 'B')
    await store.read('C', async () => 'C')

    expect(store.peek('A')).toBeUndefined()
    expect(store.peek('B')).toBe('B')
    expect(store.peek('C')).toBe('C')
  })

  it('contains a throwing synchronous subscriber so other listeners still observe every publication', async () => {
    const store = createResearchResourceStore()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const healthy = vi.fn()
    store.subscribe('A', () => { throw new Error('subscriber exploded') })
    store.subscribe('A', healthy)

    await store.read('A', async () => 'value')

    expect(healthy).toHaveBeenCalledTimes(2)
    expect(error).toHaveBeenCalledTimes(2)
  })

  it('replaces duplicate owner-key timers and clearTimers cancels every timer owned by that surface', async () => {
    vi.useFakeTimers()
    const store = createResearchResourceStore()
    const replaced = vi.fn()
    const ownerAFirst = vi.fn()
    const ownerASecond = vi.fn()
    const ownerB = vi.fn()

    store.schedule('surface-A', 'preparing:A', 100, replaced)
    store.schedule('surface-A', 'preparing:A', 100, ownerAFirst)
    store.schedule('surface-A', 'preparing:B', 100, ownerASecond)
    store.schedule('surface-B', 'preparing:A', 100, ownerB)

    expect(vi.getTimerCount()).toBe(3)
    store.clearTimers('surface-A')
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(100)

    expect(replaced).not.toHaveBeenCalled()
    expect(ownerAFirst).not.toHaveBeenCalled()
    expect(ownerASecond).not.toHaveBeenCalled()
    expect(ownerB).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    store.clearTimers('surface-B')
    expect(vi.getTimerCount()).toBe(0)
  })
})
