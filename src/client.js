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
    this._filter = mergeInto(spec, this._filter)
    return this
  }
  
  subset (spec) {
    this._query.subset(spec)
    this._subset = mergeInto(spec, this._subset)
    return this
  }
  
  embed (spec) {
    this._query.embed(spec)
    this._embed = mergeInto(spec, this._embed)
    return this
  }
  
  execute () {
    let domainTemplate = this._collection.domainTemplate
    if (domainTemplate) {
      return this._doExecute(domainTemplate)
    } else {
      // inspect domain of first coverage and assume uniform collection
      if (this._collection.coverages.length > 0) {
        return this._collection.coverages[0].loadDomain(domain => {
          this._doExecute(domain)
        })
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

function wrapCoverage (coverage, options) {
  let load = options.loader
  return API.discover(coverage).then(api => {
    // we implement this ad-hoc as we need it and refactor later
    if (api.supportsTimeSubsetting) {
      // wrap subsetByIndex and use API if only time is subsetted
      let newcov = shallowcopy(coverage)
      newcov.subsetByIndex = constraints => {
        return coverage.loadDomain().then(domain => {    
          let useApi = true
          if (Object.keys(constraints).filter(k => constraints[k] !== undefined && constraints[k] !== null).length !== 1) {
            useApi = false
          }
          // TODO don't hardcode the time axis key, search for it with referencing system info
          //  -> this is not standardized in the Coverage JS API spec yet
          let timeAxis = 't'
          if (useApi && !(timeAxis in constraints)) {
            useApi = false
          }
          if (useApi && typeof constraints.t !== 'number') {
            // TODO normalize before checking (could be start/stop/step)
            useApi = false
          }
          let timeVal
          if (useApi) {
            timeVal = domain.axes.get(timeAxis).values[constraints.t]
            if (isNaN(Date.parse(timeVal))) {
              useApi = false
            }
          }
          
          if (!useApi) {
            return coverage.subsetByIndex(constraints).then(subset2 => wrap(subset2, options))
          }
          
          let url = api.getTimeSubsetUrl(new Date(timeVal))
          return load(url).then(subset => {
            // apply remaining subset constraints
            let newconstraints = shallowcopy(constraints)
            delete newconstraints[timeAxis]
            return subset.subsetByIndex(newconstraints).then(subset2 => wrap(subset2, options))
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
