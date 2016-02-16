import {promises as jsonld} from 'jsonld'
import urltemplate from 'url-template' 

const PartialCollectionView = 'PartialCollectionView'
const IriTemplate = 'IriTemplate'
      
const COVAPI_NS = 'http://coverageapi.org/ns#'
const COVAPI_API = COVAPI_NS + 'api'
const CanInclude = COVAPI_NS + 'canInclude'

const COVJSON_NS = 'http://coveragejson.org/def#'
const Domain = COVJSON_NS + 'Domain'
const Range = COVJSON_NS + 'Range'

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
   // partial copy of http://www.hydra-cg.com/spec/latest/core/core.jsonld
   {
     "hydra": "http://www.w3.org/ns/hydra/core#",
     "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
     "rdfs": "http://www.w3.org/2000/01/rdf-schema#",
     "xsd": "http://www.w3.org/2001/XMLSchema#",
     "owl": "http://www.w3.org/2002/07/owl#",
     "vs": "http://www.w3.org/2003/06/sw-vocab-status/ns#",
     "dc": "http://purl.org/dc/terms/",
     "cc": "http://creativecommons.org/ns#",
     "property": { "@id": "hydra:property", "@type": "@vocab" },
     "required": "hydra:required",
     "view": { "@id": "hydra:view", "@type": "@id" },
     "PartialCollectionView": "hydra:PartialCollectionView",
     "totalItems": "hydra:totalItems",
     "first": { "@id": "hydra:first", "@type": "@id" },
     "last": { "@id": "hydra:last", "@type": "@id" },
     "next": { "@id": "hydra:next", "@type": "@id" },
     "previous": { "@id": "hydra:previous", "@type": "@id" },
     "IriTemplate": "hydra:IriTemplate",
     "template": "hydra:template",
     "mapping": "hydra:mapping",
     "IriTemplateMapping": "hydra:IriTemplateMapping",
     "variable": "hydra:variable"
   },
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
  .then(compacted => new API(compacted))
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
      this.paging.total = ld.totalItems
      
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
    
    if (ld[CanInclude]) {
      // server supports optional inclusion via Prefer header
      this.supportsPreferHeaders = true
    }
  }
  
  getIncludeDomainAndRangeHeaders () {
    if (!this.supportsPreferHeaders) {
      return {}
    }
    return {
      Prefer: 'return=representation; ' + 
              'include="' + Domain + ' ' + Range + '"'
    }
  }
  
  get supportsBboxSubsetting () {
    return this.supportedUrlProps.has(URL_PROPS.subsetBbox)
  }
  
  get supportsTimeFiltering () {
    return this.supportedUrlProps.has(URL_PROPS.filterTimeStart) && 
           this.supportedUrlProps.has(URL_PROPS.filterTimeEnd)
  }
  
  get supportsTimeSubsetting () {
    return this.supportedUrlProps.has(URL_PROPS.subsetTimeStart) && 
           this.supportedUrlProps.has(URL_PROPS.subsetTimeEnd)
  }
  
  getTimeFilterUrl (timeStart, timeEnd) {
    let isoStart = timeStart.toISOString()
    let isoEnd = timeEnd.toISOString()
    return urltemplate.parse(this.urlTemplate.template).expand({
      [this.supportedUrlProps.get(URL_PROPS.filterTimeStart)]: isoStart,
      [this.supportedUrlProps.get(URL_PROPS.filterTimeEnd)]: isoEnd
    })
  }
  
  /**
   * @param {Array<Date>} time [start, stop]
   * @param {Array<number>} bbox [minx,miny,maxx,maxy]
   */
  getSubsetUrl (options) {
    if (Object.keys(options).length === 0) {
      throw new Error('options cannot be empty')
    }
    let templateVars = {}
    if (options.time) {
      if (!this.supportsTimeSubsetting) {
        throw new Error('Time subsetting not supported!')
      }
      let startiso = options.time[0].toISOString()
      let stopiso = options.time[1].toISOString()
      templateVars[this.supportedUrlProps.get(URL_PROPS.subsetTimeStart)] = startiso
      templateVars[this.supportedUrlProps.get(URL_PROPS.subsetTimeEnd)] = stopiso
    }
    if (options.bbox) {
      if (!this.supportsBboxSubsetting) {
        throw new Error('BBOX subsetting not supported!')
      }
      let bboxStr = options.bbox.map(v => {
        // try toString() to avoid trailing zeros from toFixed()
        let str = v.toString()
        // if this resulted in scientific notation, use toFixed() instead
        if (str.indexOf('e') !== -1) {
          str = v.toFixed(20)
        }
        return str
      }).join(',')
      templateVars[this.supportedUrlProps.get(URL_PROPS.subsetBbox)] = bboxStr
    }
    
    return urltemplate.parse(this.urlTemplate.template).expand(templateVars)
  }
  
}
