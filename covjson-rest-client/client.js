import * as CovJSON from 'covjson-reader'
import {promises as jsonld} from 'jsonld'

const HYDRA_CONTEXT = 'http://www.w3.org/ns/hydra/core'
const PartialCollectionView = 'PartialCollectionView'
const IriTemplate = 'IriTemplate'
      
const COVAPI_NS = 'http://coverageapi.org/ns#'
const COVAPI_API = COVAPI_NS + 'api'

export function read (url) {
  return CovJSON.read(url).then(result => {
    // our main source of API information comes from data within the .ld property
    return jsonld.frame(result.ld, {
      '@context': [
        HYDRA_CONTEXT,
        {
          'api': COVAPI_API
        }
      ],
      '@id': result.id,
      'view': {}
    }).then(framed => {
      let view = framed.view
      if (view && view['@type'] === PartialCollectionView) {
        // we are in a page of a paged collection
        console.log(view)
        
      }
      let api = framed.api
      if (api && api['@graph']) {
        api = api['@graph']
        if (api['@type'] === IriTemplate) {
          // we can access the API via an IriTemplate
          console.log(api)
        }
      }
      
      // later we return our own CoverageCollection/Coverage implementation
      // which is clever and can use the API (or fall-back to the local implementation)
      return result
    })
  })
}
