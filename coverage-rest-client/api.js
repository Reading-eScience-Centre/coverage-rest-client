import {promises as jsonld} from 'jsonld'
import urltemplate from 'url-template' 

const HYDRA_CONTEXT = 'http://www.w3.org/ns/hydra/core'
const PartialCollectionView = 'PartialCollectionView'
const IriTemplate = 'IriTemplate'
      
const COVAPI_NS = 'http://coverageapi.org/ns#'
const COVAPI_API = COVAPI_NS + 'api'

const OSGEO_NS = 'http://a9.com/-/opensearch/extensions/geo/1.0/'
const OSTIME_NS = 'http://a9.com/-/opensearch/extensions/time/1.0/'

const URL_PROPS = {
    filterBbox: OSGEO_NS + 'box',
    filterTimeStart: OSTIME_NS + 'start',
    filterTimeEnd: OSTIME_NS + 'end',
    filterVerticalStart: COVAPI_NS + 'verticalStart',
    filterVerticalEnd: COVAPI_NS + 'verticalEnd',
    subsetBbox: COVAPI_NS + 'subsetBbox',
    subsetTimeStart: COVAPI_NS + 'subsetTimeStart',
    subsetTimeEnd: COVAPI_NS + 'subsetTimeEnd',
    subsetVerticalStart: COVAPI_NS + 'subsetVerticalStart',
    subsetVerticalEnd: COVAPI_NS + 'subsetVerticalEnd',
    subsetVerticalTarget: COVAPI_NS + 'subsetVerticalTarget',
    subsetIndex: COVAPI_NS + 'subsetIndex'
}

const FRAME_CONTEXT = [
   HYDRA_CONTEXT,
   {
     'id': '@id',
     'type': '@type',
     // Hydra has "@type": "@vocab" which confuses the compaction -> we override it as workaround
     // see https://github.com/json-ld/json-ld.org/issues/400
     // we also want the full object form anyway, which we can force by omitting "@type"
     "property": { "@id": "hydra:property" },
     'api': COVAPI_API
     }
   ]

/**
 * Extracts API information from the given Coverage/CoverageCollection object
 * and returns an API object.
 */
export function discover (cov) {
  // Our main source of API information comes from data within the .ld property.
  // To query that we need the id of the coverage or coveragecollection.
  if (!cov.id) {
    return Promise.resolve(new API())
  }
  return jsonld.frame(cov.ld, {
    '@context': FRAME_CONTEXT,
    id: cov.id
  })
  .then(framed => jsonld.compact(framed, framed['@context']))
  .then(compacted => {
    
    // TODO what about Prefer header for embedding?
    
    
    return new API(compacted)
  })
}

export class API {
  /**
   * @param ld A framed and compacted JSON-LD document from which Hydra data can be read.
   */
  constructor (ld) {
    this.supportedUrlProps = new Map()
    
    if (!ld) return
    console.log(ld)

    if (ld.view && ld.view.type === PartialCollectionView) {
      this.isPaged = true
      this.paging = ld.view
      
      console.log(ld.view)
    }

    if (ld.api && ld.api.type === IriTemplate) {
      this.hasUrlTemplate = true
      this.urlTemplate = ld.api
      console.log('URL template: ' + ld.api.template)
      
      let mappings = ld.api.mapping
      for (let mapping of mappings) {
        let propId = mapping.property.id
        for (let prop in URL_PROPS) {
          if (URL_PROPS[prop] === propId) {
            console.log('property recognized: ' + propId + ' (variable: ' + mapping.variable + ')')
            this.supportedUrlProps.set(propId, mapping.variable)
          }
        }          
      }
      
      console.log(ld.api)
    }
  }
  
  get supportsTimeSubsetting () {
    return this.supportedUrlProps.has(URL_PROPS.subsetTimeStart) && 
           this.supportedUrlProps.has(URL_PROPS.subsetTimeEnd)
  }
  
  /**
   * @param {Date} time The single time slice to subset to.
   */
  getTimeSubsetUrl (time) {
    let iso = time.toISOString()
    return urltemplate.parse(this.urlTemplate.template).expand({
      [this.supportedUrlProps.get(URL_PROPS.subsetTimeStart)]: iso,
      [this.supportedUrlProps.get(URL_PROPS.subsetTimeEnd)]: iso
    })
  }
  
}
