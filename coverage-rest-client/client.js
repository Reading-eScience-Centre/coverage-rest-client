import * as API from './api.js'

// Note: We currently can't handle Hydra data in non-default graphs due to lack of support in JSON-LD framing.

/**
 * Wraps a Coverage or Coverage Collection object and executes certain functions
 * via a remote API, in particular subsetting.
 * 
 * @param {object} data The Coverage API object to wrap.
 * @param {object} options Options which control the behaviour of the wrapper.
 * @param {function} options.loader 
 *   The function to use for loading coverage data from a URL.
 *   It must return a Promise succeeding with a Coverage API object. 
 * @returns {object} The wrapped Coverage API object.
 */
export function wrap (data, options) {
  if (typeof options.loader !== 'function') {
    throw new Error('options.loader must be a function')
  }
  let load = options.loader
  
  return API.discover(data).then(api => {
    if (data.coverages) {
      // collections not supported yet
      return data
    }
    
    // we implement this ad-hoc as we need it and refactor later
    if (api.supportsTimeSubsetting) {
      // wrap subsetByIndex and use API if only time is subsetted
      let newcov = shallowcopy(data)
      newcov.subsetByIndex = constraints => {
        return data.loadDomain().then(domain => {    
          let useApi = true
          if (Object.keys(constraints).filter(k => constraints[k] !== undefined && constraints[k] !== null).length !== 1) {
            useApi = false
          }
          // TODO don't hardcode the time axis key, search for it with referencing system info
          //  -> this is not standardized in the Coverage JS API spec yet
          let timeAxis = 't'
          if (!(timeAxis in constraints)) {
            useApi = false
          }
          if (typeof constraints.t !== 'number') {
            // TODO normalize before checking (could be single-element array or start/stop/step)
            useApi = false
          }
          let timeVal = domain.axes.get(timeAxis).values[constraints.t]
          if (isNaN(Date.parse(timeVal))) {
            useApi = false
          }
          
          if (!useApi) {
            return data.subsetByIndex(constraints)
          }
          
          let url = api.getTimeSubsetUrl(new Date(timeVal))
          return load(url).then(subset => wrap(subset, options))
        })
      }
      return newcov
    }
    
    return data
  })
}

function shallowcopy (obj) {
  let copy = Object.create(Object.getPrototypeOf(obj))
  for (let prop in obj) {
    copy[prop] = obj[prop]
  }
  return copy
}
