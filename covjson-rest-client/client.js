import * as CovJSON from 'covjson-reader'
import * as API from './api.js'

// Note: We currently can't handle Hydra data in non-default graphs due to lack of support in JSON-LD framing.

// TODO think about making this library independent of CoverageJSON

export function read (url) {
  return CovJSON.read(url).then(result => {
    return API.discover(result).then(api => {
      
      // later we return our own CoverageCollection/Coverage implementation
      // which is clever and can use the API (or fall-back to the local implementation)
      return result
    })
  })
}
