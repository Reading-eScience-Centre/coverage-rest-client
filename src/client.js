import * as API from './api.js'
import * as arrays from './arrays.js'

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
          
          if (!requiresSubsetting(domain, constraints)) {
            return newcov
          }
          
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
          
          let url = api.getSubsetUrl({time: new Date(timeVal)})
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
          constraints = cleanedConstraints(constraints)
          
          if (!requiresSubsetting(domain, constraints)) {
            return newcov
          }
                    
          // TODO don't hardcode
          let xAxis = 'x'
          let yAxis = 'y'
          let tAxis = 't'
          let apiSupport = new Map([
            [xAxis, {
              intersect: api.supportsBboxSubsetting, // start/stop subsetting
              identity: false, // exact subsetting (e.g. for times useful)
              target: false, // nearest neighbor subsetting
              depends: [yAxis]
            }],
            [yAxis, {
              intersect: api.supportsBboxSubsetting,
              identity: false,
              target: false,
              depends: [xAxis]
            }],
            [tAxis, {
              intersect: api.supportsTimeSubsetting,
              identity: false,
              target: false
            }]
          ])
          
          /* If the API does not support target-based subsetting, then this can be emulated
           * via intersection-based subsetting by inspecting the domain locally first
           * and then subsetting with equal start/stop subsetting.
           * 
           * Identity-based subsetting can in general not be emulated by the other methods.
           */
            
          // we split the subsetting constraints into API-compatible and local ones
          let apiConstraints = new Map()
          let localConstraints = new Map()
          for (let axis of Object.keys(constraints)) {
            let useApi = false
            let constraint = constraints[axis]
            
            if (!apiSupport.has(axis)) {
              // leave useApi = false
            } else if (typeof constraint !== 'object') {
              useApi = apiSupport.get(axis).identity
            } else if ('target' in constraint) {
              if (apiSupport[axis].target) {
                useApi = true
              } else if (apiSupport.get(axis).intersect) {
                // emulate target via intersect
                let idx = getClosestIndex(domain, axis, constraint.target)
                let val = domain.axes.get(axis).values[idx]
                constraint = {start: val, stop: val}
                useApi = true
              }
            } else {
              // start / stop
              useApi = apiSupport.get(axis).intersect
            }
                         
            if (useApi) {
              apiConstraints.set(axis, constraint)
            } else {
              localConstraints.set(axis, constraint)
            }
          }
          
          // check if all API dependencies between axes are met
          // this is mainly for bounding box which needs both x and y
          // if not, move to locally applied constraints
          for (let [axis, constraint] of new Map(apiConstraints)) {
            let depends = apiSupport.get(axis).depends
            if (depends && depends.some(ax => !apiConstraints.has(ax))) {
              apiConstraints.delete(axis)
              localConstraints.set(axis, constraint)
            }
          }
          
          if (apiConstraints.size === 0) {
            // again, we DON'T wrap the locally subsetted coverage again, see above
            return coverage.subsetByValue(constraints)
          }
          
          // TODO avoid hard-coding this
          let options = {}
          if (apiConstraints.has(xAxis)) {
            let x = apiConstraints.get(xAxis)
            let y = apiConstraints.get(yAxis)
            options.bbox = [x.start, y.start, x.stop, y.stop]
          }
          if (apiConstraints.has(tAxis)) {
            let t = apiConstraints.get(tAxis)
            options.time = [t.start, t.stop]
          }

          let url = api.getSubsetUrl(options)
          
          return load(url).then(subset => {
            // apply remaining subset constraints
            if (localConstraints.size > 0) {
              let constraints = {}
              for (let [axis, constraint] of localConstraints) {
                constraints[axis] = constraint 
              }
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

function getClosestIndex (domain, axis, val) {
  let vals = domain.axes.get(axis).values
  if (axis === 't') {
    // convert to unix timestamps as we need numbers
    val = val.getTime()
    vals = vals.map(t => new Date(t).getTime())
  }
  let idx = arrays.indexOfNearest(vals, val)
  return idx
}

/**
 * Checks whether the constraints may result in an actual
 * subsetting of the coverage (=true), or whether they are guaranteed
 * to have no effect (=false). 
 */
function requiresSubsetting (domain, constraints) {
  for (let axisKey of Object.keys(constraints)) {
    let len = domain.axes.get(axisKey).values.length
    if (len > 1) {
      return true
    }
  }  
  return false
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
