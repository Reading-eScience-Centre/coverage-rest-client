export function shallowcopy (obj) {
  let copy = Object.create(Object.getPrototypeOf(obj))
  for (let prop in obj) {
    copy[prop] = obj[prop]
  }
  return copy
}

export function mergeInto (inputObj, targetObj) {
  for (let k of Object.keys(inputObj)) {
    targetObj[k] = inputObj[k]
  }
}