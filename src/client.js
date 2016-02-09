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
 *   It is called as loader(url, headers) where headers is an optional object
 *   of HTTP headers to send.
 *   It must return a Promise succeeding with a Coverage API object.
 *   
 * @returns {object} The wrapped Coverage API object.
 */
export function wrap (data, options) {
  if (typeof options.loader !== 'function') {
    throw new Error('options.loader must be a function')
  }
  if (data.coverages) {
    return wrapCollection(data, options)
  } else {
    return wrapCoverage(data, options)
  }
}

function wrapCollection (collection, options) {
  // TODO wrap each individual coverage as well!
  return API.discover(collection).then(api => {
    let newcoll = shallowcopy(collection)
    newcoll.query = () => {
      let query = collection.query()
      return new QueryProxy(query, newcoll, api, options)
    }
    if (api.isPaged) {
      let load = options.loader
      let wrapPageLink = url => {
        if (!url) return
        return {
          // FIXME send Prefer header if used in query()
          //  -> would be a lot easier if this was a URL parameter
          load: () => load(url).then(coll => wrap(coll, options))
        }
      }
      newcoll.paging = {
        total: api.paging.total,
        previous: wrapPageLink(api.paging.previous),
        next: wrapPageLink(api.paging.next),
        first: wrapPageLink(api.paging.first),
        last: wrapPageLink(api.paging.last)
      }
    }
    return newcoll
  })
}

/**
 * Collects the query parts and executes the query remotely
 * if possible.
 */
class QueryProxy {
  constructor (query, collection, api, options) {
    this._query = query
    this._collection = collection
    this._api = api
    this._options = options
    
    this._filter = {}
    this._subset = {}
    this._embed = {}
  }
  
  filter (spec) {
    this._query.filter(spec)
    mergeInto(spec, this._filter)
    return this
  }
  
  subset (spec) {
    this._query.subset(spec)
    mergeInto(spec, this._subset)
    return this
  }
  
  embed (spec) {
    this._query.embed(spec)
    mergeInto(spec, this._embed)
    return this
  }
  
  execute () {
    let domainTemplate = this._collection.domainTemplate
    if (domainTemplate) {
      return this._doExecute(domainTemplate)
    } else {
      // inspect domain of first coverage and assume uniform collection
      if (this._collection.coverages.length > 0) {
        return this._collection.coverages[0].loadDomain().then(domain => this._doExecute(domain))
      } else {
        return this._query.execute()
      }
    }
  }
  
  _doExecute (domainTemplate) {
    let load = this._options.loader
    let useApi = true
    
    // we implement this ad-hoc as we need it and refactor later
    // currently only time filtering support
    
    // filter by time
    if (!this._api.supportsTimeFiltering) {
      useApi = false
    }
    
    // TODO don't hardcode the time axis key, search for it with referencing system info
    //  -> this is not standardized in the Coverage JS API spec yet
    let timeAxis = 't'
    if (useApi && !(timeAxis in this._filter)) {
      useApi = false
    }
    
    if (useApi && !this._filter[timeAxis]) {
      useApi = false
    }
    
    if (!useApi) {
      return this._query.execute()
    }
    
    let {start, stop} = this._filter[timeAxis]
    let url = this._api.getTimeFilterUrl(new Date(start), new Date(stop))
    
    let headers = {}
    if (this._embed['range']) {
      // TODO this should be applied independent of whether the time filter
      //  is applied
      mergeInto(this._api.getIncludeDomainAndRangeHeaders(), headers)
    }
    
    return load(url, headers).then(filtered => {
      // apply remaining query parts
      let newfilter = shallowcopy(this._filter)
      delete newfilter[timeAxis]
      return filtered.query()
        .filter(newfilter)
        .subset(this._subset)
        .embed(this._embed)
        .execute().then(newcoll => wrap(newcoll, this._options))
    })
  }
}

function cleanedConstraints (constraints) {
  let cleanConstraints = shallowcopy(constraints)
  for (let key of Object.keys(constraints)) {
    if (constraints[key] === undefined || constraints[key] === null) {
      delete cleanConstraints[key]
    }
  }
  return cleanConstraints
}

function wrapCoverage (coverage, options) {
  let load = options.loader
  return API.discover(coverage).then(api => {
    // we implement this ad-hoc as we need it and refactor later
    
    // TODO wrap subsetByValue
    
    if (api.supportsTimeSubsetting || api.supportsBboxSubsetting) {
      // wrap subsetByIndex and use API if only time is subsetted
      let newcov = shallowcopy(coverage)     
      
      newcov.subsetByIndex = constraints => {
        return coverage.loadDomain().then(domain => {    
          let useApi = true
          
          if (!api.supportsTimeSubsetting) {
            useApi = false
          }
          
          constraints = cleanedConstraints(constraints)
          
          if (useApi && Object.keys(constraints).length !== 1) {
            useApi = false
          }
          // TODO don't hardcode the time axis key, search for it with referencing system info
          //  -> this is not standardized in the Coverage JS API spec yet
          let timeAxis = 't'
          if (useApi && !(timeAxis in constraints)) {
            useApi = false
          }
          if (useApi && typeof constraints[timeAxis] !== 'number') {
            // TODO normalize before checking (could be start/stop/step)
            useApi = false
          }
          let timeVal
          if (useApi) {
            timeVal = domain.axes.get(timeAxis).values[constraints[timeAxis]]
            if (isNaN(Date.parse(timeVal))) {
              useApi = false
            }
          }
          
          if (!useApi) {
            // Note that we DON'T wrap the locally subsetted coverage again.
            // This would be incorrect as a partially applied local subset would not be
            // known by the API metadata and therefore a subsequent API subset operation would
            // return wrong data (too much).
            // A way out would be to attach the original API info to the original coverage identity,
            // which can be established with "subsetOf".
            // Somewhere the constraints used for subsetting would have to be stored as well,
            // so that we can reproduce them.
            // E.g.:
            // 1. Coverage A with API info
            // 2. Subset Coverage A by bounding box without API -> Coverage B with subset relationship to Coverage A
            // 3. Subset Coverage B by time
            //  3.1. Subset Coverage A by time with API -> Coverage C with API info
            //  3.2. Subset Coverage C by bounding box without API -> Coverage D with subset relationship to Coverage C
            // TODO implement that or think of something simpler
            return coverage.subsetByIndex(constraints)
          }
          
          let url = api.getTimeSubsetUrl(new Date(timeVal))
          return load(url).then(subset => {
            // apply remaining subset constraints
            delete constraints[timeAxis]
            if (Object.keys(constraints).length > 0) {
              // again, we DON'T wrap the locally subsetted coverage again, see above
              return subset.subsetByIndex(constraints)
            } else {
              return wrap(subset, options)
            }
          })
        })
      }
      
      newcov.subsetByValue = constraints => {
        return coverage.loadDomain().then(domain => {
          let useApi = true
          
          constraints = cleanedConstraints(constraints)
          
          // TODO don't hardcode
          let xAxis = 'x'
          let yAxis = 'y'
            
          if (!(xAxis in constraints) || !(yAxis in constraints)) {
            useApi = false
          }
          
          if (useApi && (typeof constraints[xAxis] !== 'object' || typeof constraints[yAxis] !== 'object')) {
            useApi = false
          }
          
          if (useApi && ('target' in constraints[xAxis] || 'target' in constraints[yAxis])) {
            useApi = false
          }
          
          if (!useApi) {
            // again, we DON'T wrap the locally subsetted coverage again, see above
            return coverage.subsetByValue(constraints)
          }
          
          let bbox = [constraints[xAxis].start, constraints[yAxis].start,
                      constraints[xAxis].stop, constraints[yAxis].stop]
          
          let url = api.getBboxSubsetUrl(bbox)
          return load(url).then(subset => {
            // apply remaining subset constraints
            delete constraints[xAxis]
            delete constraints[yAxis]
            if (Object.keys(constraints).length > 0) {
              // again, we DON'T wrap the locally subsetted coverage again, see above
              return subset.subsetByValue(constraints)
            } else {
              return wrap(subset, options)
            }
          })
        })
      }
      
      return newcov
    }
    
    return coverage
  })
}

function shallowcopy (obj) {
  let copy = Object.create(Object.getPrototypeOf(obj))
  for (let prop in obj) {
    copy[prop] = obj[prop]
  }
  return copy
}

function mergeInto (inputObj, targetObj) {
  for (let k of Object.keys(inputObj)) {
    targetObj[k] = inputObj[k]
  }
}
