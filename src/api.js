import {promises as jsonld, default as jsonldOriginal} from 'jsonld'
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

/*
 * We are using a custom jsonld document loader to skip loading the CovJSON context URL
 * which may be included in the document. Instead we load a local partial copy of it.
 */
const CONTEXTS = {
  "https://rawgit.com/reading-escience-centre/coveragejson/master/contexts/coveragejson-base.jsonld": 
    {
      "@context": {
        "id": "@id",
        "type": "@type"
      }
    }
}
const customLoader = function (url) {
  if (url in CONTEXTS) {
    return Promise.resolve({
      contextUrl: null, // this is for a context via a link header
      document: CONTEXTS[url], // this is the actual document that was loaded
      documentUrl: url // this is the actual context URL after redirects
    })
  }
  // fall-back to default loader
  return jsonldOriginal.documentLoader(url)
}
const jsonldOpts = {
  documentLoader: customLoader
}

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
  }, jsonldOpts)
  .then(framed => jsonld.compact(framed, framed['@context'], jsonldOpts))
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
    
    this._createCapabilities()
  }
  
  get supportsBboxFiltering () {
    return this.supportedUrlProps.has(URL_PROPS.filterBbox)
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
  
  get supportsVerticalFiltering () {
    return this.supportedUrlProps.has(URL_PROPS.filterVerticalStart) && 
           this.supportedUrlProps.has(URL_PROPS.filterVerticalEnd)    
  }
  
  get supportsVerticalSubsetting () {
    return this.supportedUrlProps.has(URL_PROPS.subsetVerticalStart) && 
           this.supportedUrlProps.has(URL_PROPS.subsetVerticalEnd)
  }
  
  get supportsVerticalTargetSubsetting () {
    return this.supportedUrlProps.has(URL_PROPS.subsetVerticalTarget)
  }
  
  get supportsIndexSubsetting () {
    return this.supportedUrlProps.has(URL_PROPS.subsetIndex)
  }
  
  _createCapabilities () {
    let caps = {
      filter: {},
      subset: {},
      embed: {}
    }
    let startstop = () => ({
      start: true,
      stop: true
    })
    if (this.supportsBboxFiltering) {
      // 'x' is not the axis name, it just represents the x-axis in a horizontal CRS
      caps.filter.x = {
        start: true,
        stop: true,
        dependency: ['y']
      }
      caps.filter.y = {
        start: true,
        stop: true,
        dependency: ['x']
      }
    }
    if (this.supportsTimeFiltering) {
      caps.filter.time = startstop()
    }
    if (this.supportsVerticalFiltering) {
      caps.filter.vertical = startstop()
    }
    if (this.supportsBboxSubsetting) {
      caps.subset.x = {
        start: true,
        stop: true,
        dependency: ['y']
      }
      caps.subset.y = {
        start: true,
        stop: true,
        dependency: ['x']
      }
    }
    if (this.supportsTimeSubsetting) {
      caps.subset.time = startstop()
    }
    if (this.supportsVerticalSubsetting) {
      caps.subset.vertical = startstop()
    }
    if (this.supportsVerticalTargetSubsetting) {
      if (!caps.subset.vertical) {
        caps.subset.vertical = {}
      }
      caps.subset.vertical.target = true
    }
    if (this.supportsIndexSubsetting) {
      caps.subset.index = {
        start: true,
        stop: true,
        step: true
      }
    }
    if (this.supportsPreferHeaders) {
      caps.embed = {
        domain: true,
        range: true
      }
    }
    this.capabilities = caps
  }
  
  /**
   * Option keys: time, x, y, vertical, embed
   * 
   * Each value except for 'embed' is one of (check this.capabilities to see which ones are supported!):
   * 
   * {start, stop} // intersect match
   * 
   * 'embed' is an object {domain: true, range: true} where both members are optional.
   */
  _getFilterTemplateVars (options = {}) {
    let templateVars = {}
    if (options.time) {
      if (!this.supportsTimeFiltering) {
        throw new Error('Time filtering not supported!')
      }
      let isoStart = options.time.start
      let isoEnd = options.time.stop
      templateVars[this.supportedUrlProps.get(URL_PROPS.filterTimeStart)] = isoStart
      templateVars[this.supportedUrlProps.get(URL_PROPS.filterTimeEnd)] = isoEnd
      delete options.time
    }
    if (options.vertical) {
      if (!this.supportsVerticalFiltering) {
        throw new Error('Vertical filtering not supported!')
      }
      let start = getNumberString(options.vertical.start)
      let end = getNumberString(options.vertical.stop)
      templateVars[this.supportedUrlProps.get(URL_PROPS.filterVerticalStart)] = start
      templateVars[this.supportedUrlProps.get(URL_PROPS.filterVerticalEnd)] = end
      delete options.vertical
    }
    if (options.x) {
      if (!this.supportsBboxFiltering) {
        throw new Error('BBOX filtering not supported!')
      }
      let bboxStr = getBboxString([options.x.start, options.y.start, options.x.stop, options.y.stop])
      templateVars[this.supportedUrlProps.get(URL_PROPS.filterBbox)] = bboxStr
      delete options.x
      delete options.y
    }
    checkEmpty(options, 'Unrecognized filter options')

    return templateVars
  }
  
  /**
   * Option keys: time, x, y, vertical, index
   * 
   * Each value is one of (check this.capabilities to see which ones are supported!):
   * 
   * For time, x, y, vertical:
   * ISO string // exact match (time)
   * number // exact match (x, y, vertical) <- typically not supported by API
   * {start, stop} // intersect match
   * {target} // nearest neighbor match
   * 
   * For index:
   * {<axisName>: integer, ...}
   * {<axisName>: {start,stop[,step]}, ...}
   */
  _getSubsetTemplateVars (options = {}) {
    let templateVars = {}
    if (options.time) {
      if (!this.supportsTimeSubsetting) {
        throw new Error('Time subsetting not supported!')
      }
      let isoStart = options.time.start
      let isoEnd = options.time.stop
      templateVars[this.supportedUrlProps.get(URL_PROPS.subsetTimeStart)] = isoStart
      templateVars[this.supportedUrlProps.get(URL_PROPS.subsetTimeEnd)] = isoEnd
      delete options.time
    }
    if (options.x) {
      if (!this.supportsBboxSubsetting) {
        throw new Error('BBOX subsetting not supported!')
      }
      let bboxStr = getBboxString([options.x.start, options.y.start, options.x.stop, options.y.stop])
      templateVars[this.supportedUrlProps.get(URL_PROPS.subsetBbox)] = bboxStr
      delete options.x
      delete options.y
    }
    if (options.vertical) {
      if (options.vertical.target) {
        if (!this.supportsVerticalTargetSubsetting) {
          throw new Error('vertical target subsetting not supported!')
        }
        let target = getNumberString(options.vertical.target)
        templateVars[this.supportedUrlProps.get(URL_PROPS.subsetVerticalTarget)] = target
      }
      if (options.vertical.start) {
        if (!this.supportsVerticalSubsetting) {
          throw new Error('vertical subsetting not supported!')
        }
        let start = getNumberString(options.vertical.start)
        let end = getNumberString(options.vertical.stop)
        templateVars[this.supportedUrlProps.get(URL_PROPS.subsetVerticalStart)] = start
        templateVars[this.supportedUrlProps.get(URL_PROPS.subsetVerticalEnd)] = end 
      }
      delete options.vertical
    }
    if (options.index) {
      if (!this.supportsIndexSubsetting) {
        throw new Error('index subsetting not supported!')
      }
      let strings = []
      for (let axis of Object.keys(options.index)) {
        strings.push(getIndexSubsetString(axis, options.index[axis]))
      }
      templateVars[this.supportedUrlProps.get(URL_PROPS.subsetIndex)] = strings
    }
    checkEmpty(options, 'Unrecognized subset options')
    
    return templateVars
  }
  
  _getIncludeDomainAndRangeHeaders (options = {}) {
    if (!this.supportsPreferHeaders) {
      return {}
    }
    let uris = []
    if (options.domain) {
      uris.push(Domain)
    }
    if (options.range) {
      uris.push(Range)
    }
    return {
      Prefer: 'return=representation; ' + 
              'include="' + uris.join(' ') + '"'
    }
  }
  
  getUrlAndHeaders (options) {
    // deep-copy as we delete properties after they are applied
    options = JSON.parse(JSON.stringify(options))
    let subsetTemplateVars = this._getSubsetTemplateVars(options.subset)
    let filterTemplateVars = this._getFilterTemplateVars(options.filter)
    
    let templateVars = subsetTemplateVars
    for (let key in filterTemplateVars) {
      templateVars[key] = filterTemplateVars[key]
    }
    
    let url = urltemplate.parse(this.urlTemplate.template).expand(templateVars)
    let headers = this._getIncludeDomainAndRangeHeaders(options.embed)
    return {url, headers}
  }
  
}

function checkEmpty (obj, err) {
  if (Object.keys(obj).length > 0) {
    throw new Error(err)
  }
}

function getBboxString (bbox) {
  return bbox.map(getNumberString).join(',')
}

/**
 * Converts a number to a decimal string in non-scientific notation.
 */
function getNumberString (num) {
  // try toString() to avoid trailing zeros from toFixed()
  let str = num.toString()
  // if this resulted in scientific notation, use toFixed() instead
  if (str.indexOf('e') !== -1) {
    str = num.toFixed(20)
  }
  return str
}

function getIndexSubsetString (axis, spec) {
  let slice
  if (typeof spec === 'number') {
    slice = getNumberString(spec)
  } else if (spec.start === spec.stop && (!spec.step || spec.step === 1)) {
    slice = getNumberString(spec.start)
  } else {
    slice = getNumberString(spec.start) + ':' + getNumberString(stop)
    if (spec.step) {
      slice += ':' + getNumberString(spec.step)
    }
  }
  return axis + '[' + slice + ']'
}

