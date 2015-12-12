import * as API from './api.js'

// Note: We currently can't handle Hydra data in non-default graphs due to lack of support in JSON-LD framing.

/**
 * Wraps a Coverage or Coverage Collection object and executes certain functions
 * via a remote API, in particular subsetting.
 * 
 * @param {object} data The Coverage API object to wrap.
 * @param {object} options Controls which operations should be run locally or remotely.
 * @returns {object} The wrapped Coverage API object.
 */
export function wrap (data, options) {
  return API.discover(data).then(api => {
    
    // later we return our own CoverageCollection/Coverage implementation
    // which is clever and can use the API (or fall-back to the local implementation)
    return data
  })
}
