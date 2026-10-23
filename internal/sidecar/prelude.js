// The prelude runs once in every new runtime, before the program. Its
// completion value is the setup function, which builds the values the program
// receives as parameters: one null-prototype object per binding namespace,
// the namespaces' error classes, and a console with five methods. The console
// is also a global, as in Node, so the modules a program imports can log;
// the binding namespaces are not. The setup function returns those values
// and a function that returns node:util's inspect, with the check
// util.format makes for %s.
//
// console renders a value as dsh's Node runtime does: with util.inspect and
// the options { depth: 4, maxArrayLength: 100, maxStringLength: 10000 }.
// loadInspect returns makeInspect of inspect.js, which builds them on first
// use.
(function setup(namespaces, call, log, loadInspect, promiseDetails, headerLength) {
  'use strict'

  const { create, defineProperty } = Object

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

  let inspection
  const inspector = () => inspection ??= loadInspect()(promiseDetails, headerLength)
  // The options dsh's Node runtime gives util.inspect for console output.
  const consoleOptions = { depth: 4, maxArrayLength: 100, maxStringLength: 10000 }

  function render(args) {
    let line = ''
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]
      line += (index === 0 ? '' : ' ') + (typeof arg === 'string' ? arg : inspector().inspect(arg, consoleOptions))
    }
    return line
  }

  const consoleObject = create(null)
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    defineProperty(consoleObject, level, { enumerable: true, value: (...args) => { log(render(args)) } })
  }
  defineProperty(globalThis, 'console', { value: consoleObject, writable: true, configurable: true })

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
  return [[...params, ...classes, consoleObject], inspector]
})
