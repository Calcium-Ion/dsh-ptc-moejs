// The prelude runs once in every new runtime, before the program. Its
// completion value is the setup function, which builds the values the program
// receives as parameters: one null-prototype object per binding namespace,
// the namespaces' error classes, and a console with five methods. The
// program's global object stays as moejs creates it.
(function setup(namespaces, call, log) {
  'use strict'

  const { create, defineProperty, getOwnPropertyDescriptor, getOwnPropertySymbols, getPrototypeOf, keys } = Object
  const apply = Reflect.apply
  const functionToString = Function.prototype.toString
  const errorToString = Error.prototype.toString
  const symbolToString = Symbol.prototype.toString
  const dateToISOString = Date.prototype.toISOString
  const dateGetTime = Date.prototype.getTime
  const regExpToString = RegExp.prototype.toString
  const mapForEach = Map.prototype.forEach
  const setForEach = Set.prototype.forEach
  const mapSize = getOwnPropertyDescriptor(Map.prototype, 'size').get
  const setSize = getOwnPropertyDescriptor(Set.prototype, 'size').get
  const typedArrayPrototype = getPrototypeOf(Uint8Array.prototype)
  const typedArrayLength = getOwnPropertyDescriptor(typedArrayPrototype, 'length').get

  // The limits Node's PTC console uses: deep enough to be useful, bounded so
  // one value cannot explode the rendering.
  const MAX_DEPTH = 4
  const MAX_ITEMS = 100
  const MAX_STRING = 10000
  const LINE_WIDTH = 72

  function makeErrorClass(name, memberNameProperty) {
    const BindingError = class extends Error {
      constructor(memberName, message) {
        super(message)
        defineProperty(this, 'name', { value: name, enumerable: true })
        defineProperty(this, memberNameProperty, { value: memberName, enumerable: true })
      }
    }
    defineProperty(BindingError, 'name', { value: name })
    return BindingError
  }

  function binding(global, name, ErrorClass) {
    const fail = (message) => {
      throw ErrorClass === undefined ? new Error(message) : new ErrorClass(name, message)
    }
    return (args) => call(global, name, args).then(undefined, fail)
  }

  function quote(text) {
    let rest = ''
    if (text.length > MAX_STRING) {
      rest = `... ${text.length - MAX_STRING} more characters`
      text = text.slice(0, MAX_STRING)
    }
    const mark = !text.includes("'") ? "'" : !text.includes('"') ? '"' : !text.includes('`') ? '`' : "'"
    let out = mark
    for (const ch of text) {
      const code = ch.charCodeAt(0)
      if (ch === mark || ch === '\\') out += '\\' + ch
      else if (ch === '\n') out += '\\n'
      else if (ch === '\t') out += '\\t'
      else if (ch === '\r') out += '\\r'
      else if (ch === '\b') out += '\\b'
      else if (ch === '\f') out += '\\f'
      else if (ch === '\v') out += '\\v'
      else if (code < 0x20 || code === 0x7f) out += '\\x' + code.toString(16).padStart(2, '0').toUpperCase()
      else out += ch
    }
    return out + mark + rest
  }

  function formatKey(key) {
    if (typeof key === 'symbol') return `[${apply(symbolToString, key, [])}]`
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : quote(key)
  }

  function formatFunction(fn) {
    let source = ''
    try { source = apply(functionToString, fn, []) } catch {}
    const name = typeof fn.name === 'string' ? fn.name : ''
    if (source.startsWith('class')) return name ? `[class ${name}]` : '[class (anonymous)]'
    const kind = source.startsWith('async function*') ? 'AsyncGeneratorFunction'
      : source.startsWith('async') ? 'AsyncFunction'
        : /^function\s*\*/.test(source) ? 'GeneratorFunction' : 'Function'
    return name ? `[${kind}: ${name}]` : `[${kind} (anonymous)]`
  }

  function formatError(error, depth) {
    let text
    try {
      text = typeof error.stack === 'string' && error.stack !== '' ? error.stack : apply(errorToString, error, [])
    } catch {
      text = '[Error]'
    }
    return depth === 0 ? text : `[${text.split('\n')[0]}]`
  }

  function constructorName(value) {
    const proto = getPrototypeOf(value)
    if (proto === null) return null
    const ctor = getOwnPropertyDescriptor(proto, 'constructor')?.value
    return typeof ctor === 'function' && typeof ctor.name === 'string' && ctor.name !== '' ? ctor.name : 'Object'
  }

  // Own enumerable properties, accessors shown without running them.
  function ownEntries(value, depth, seen, indent, skipIndices) {
    const entries = []
    for (const key of [...keys(value), ...getOwnPropertySymbols(value)]) {
      if (skipIndices && typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key)) continue
      const descriptor = getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !descriptor.enumerable) continue
      const shown = descriptor.get !== undefined || descriptor.set !== undefined
        ? descriptor.get === undefined ? '[Setter]' : descriptor.set === undefined ? '[Getter]' : '[Getter/Setter]'
        : format(descriptor.value, depth + 1, seen, indent + '  ')
      entries.push(`${formatKey(key)}: ${shown}`)
    }
    return entries
  }

  function wrap(prefix, open, entries, close, indent) {
    if (entries.length === 0) return `${prefix}${open}${close}`
    const line = entries.join(', ')
    if (prefix.length + line.length + 4 <= LINE_WIDTH && !line.includes('\n')) return `${prefix}${open} ${line} ${close}`
    return `${prefix}${open}\n${indent}  ${entries.join(`,\n${indent}  `)}\n${indent}${close}`
  }

  function format(value, depth, seen, indent) {
    switch (typeof value) {
      case 'string': return quote(value)
      case 'number': return Object.is(value, -0) ? '-0' : String(value)
      case 'bigint': return `${value}n`
      case 'boolean':
      case 'undefined': return String(value)
      case 'symbol': return apply(symbolToString, value, [])
      case 'function': return formatFunction(value)
    }
    if (value === null) return 'null'
    if (seen.includes(value)) return '[Circular]'
    if (value instanceof Error) return formatError(value, depth)
    if (value instanceof Date) {
      const time = apply(dateGetTime, value, [])
      return time === time ? apply(dateToISOString, value, []) : 'Invalid Date'
    }
    if (value instanceof RegExp) return apply(regExpToString, value, [])
    if (value instanceof Promise) return 'Promise {}'
    if (value instanceof WeakMap || value instanceof WeakSet) return `${value instanceof WeakMap ? 'WeakMap' : 'WeakSet'} { <items unknown> }`
    if (value instanceof Number || value instanceof String || value instanceof Boolean) {
      return `[${constructorName(value)}: ${format(value.valueOf(), depth + 1, seen, indent)}]`
    }
    const name = constructorName(value)
    if (depth > MAX_DEPTH) return Array.isArray(value) ? '[Array]' : `[${name ?? 'Object'}]`
    seen.push(value)
    try {
      if (Array.isArray(value) || value instanceof typedArrayPrototype.constructor) {
        const length = Array.isArray(value) ? value.length : apply(typedArrayLength, value, [])
        const items = []
        for (let index = 0; index < length && index < MAX_ITEMS; index++) {
          items.push(index in value ? format(value[index], depth + 1, seen, indent + '  ') : '<empty item>')
        }
        if (length > MAX_ITEMS) items.push(`... ${length - MAX_ITEMS} more item${length - MAX_ITEMS === 1 ? '' : 's'}`)
        items.push(...ownEntries(value, depth, seen, indent, true))
        const prefix = name === 'Array' ? '' : `${name ?? '[Array: null prototype]'}(${length}) `
        return wrap(prefix, '[', items, ']', indent)
      }
      if (value instanceof Map || value instanceof Set) {
        const isMap = value instanceof Map
        const items = []
        const add = isMap
          ? (item, key) => { if (items.length < MAX_ITEMS) items.push(`${format(key, depth + 1, seen, indent + '  ')} => ${format(item, depth + 1, seen, indent + '  ')}`) }
          : (item) => { if (items.length < MAX_ITEMS) items.push(format(item, depth + 1, seen, indent + '  ')) }
        apply(isMap ? mapForEach : setForEach, value, [add])
        const size = apply(isMap ? mapSize : setSize, value, [])
        if (size > MAX_ITEMS) items.push(`... ${size - MAX_ITEMS} more item${size - MAX_ITEMS === 1 ? '' : 's'}`)
        items.push(...ownEntries(value, depth, seen, indent, false))
        return wrap(`${name ?? (isMap ? 'Map' : 'Set')}(${size}) `, '{', items, '}', indent)
      }
      const prefix = name === null ? '[Object: null prototype] ' : name === 'Object' ? '' : `${name} `
      return wrap(prefix, '{', ownEntries(value, depth, seen, indent, false), '}', indent)
    } finally {
      seen.pop()
    }
  }

  function render(args) {
    let line = ''
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]
      line += (index === 0 ? '' : ' ') + (typeof arg === 'string' ? arg : format(arg, 0, [], ''))
    }
    return line
  }

  const consoleObject = create(null)
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    defineProperty(consoleObject, level, { enumerable: true, value: (...args) => { log(render(args)) } })
  }

  const params = []
  const classes = []
  for (const namespace of namespaces) {
    const target = create(null)
    const ErrorClass = namespace.errorClass === undefined
      ? undefined
      : makeErrorClass(namespace.errorClass.name, namespace.errorClass.memberNameProperty)
    for (const name of namespace.names) {
      defineProperty(target, name, { enumerable: true, value: binding(namespace.global, name, ErrorClass) })
    }
    params.push(target)
    if (ErrorClass !== undefined) classes.push(ErrorClass)
  }
  return [...params, ...classes, consoleObject]
})
