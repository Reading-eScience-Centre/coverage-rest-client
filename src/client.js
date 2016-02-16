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
    
    // TODO rewrite this
    
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
    let url = this._api.getFilterUrl({time: [new Date(start), new Date(stop)]})
    
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
  return API.discover(coverage).then(api => {
    let wrappedCoverage = shallowcopy(coverage)
    wrappedCoverage.subsetByIndex = wrappedSubsetByIndex(coverage, wrappedCoverage, api, options)
    wrappedCoverage.subsetByValue = wrappedSubsetByValue(coverage, wrappedCoverage, api, options)
    return wrappedCoverage
  })
}

function wrappedSubsetByIndex (coverage, wrappedCoverage, api, wrapOptions) {
  return constraints => {
    return coverage.loadDomain().then(domain => {              
      constraints = cleanedConstraints(constraints)
      
      if (!requiresSubsetting(domain, constraints)) {
        return wrappedCoverage
      }
      
      let caps = api.capabilities.subset
      let axisMap = getAxisConcepts(domain)
      
      /*
       * If the API supports generic index-based subsetting, then this is used.
       * If not, several emulation strategies are used instead (if possible).
       */
                
      // we split the subsetting constraints into API-compatible and local ones
      let apiConstraints = {} // API concept -> spec
      let localConstraints = {} // axis name -> spec
      
      if (caps.index) {
        apiConstraints.index = constraints
      } else {
        // try to emulate some constraints
        for (let axis of Object.keys(constraints)) {
          let useApi = false
          let constraint = constraints[axis]
          
          if (!caps[axisMap[axis]]) {
            // leave useApi = false
          } else if (typeof constraint !== 'object') {
            if (caps[axisMap[axis]].start && caps[axisMap[axis]].stop) {
              // emulate identity match via start/stop
              let val = domain.axes.get(axis).values[constraint]
              constraint = {start: val, stop: val}
              useApi = true
            }
          } else if (!constraint.step) {
            // start / stop
            if (caps[axisMap[axis]].start && caps[axisMap[axis]].stop) {
              let start = domain.axes.get(axis).values[constraint.start]
              let stop = domain.axes.get(axis).values[constraint.stop]
              constraint = {start, stop}
              useApi = true
            }
          }
                       
          if (useApi) {
            apiConstraints[axisMap[axis]] = constraint
          } else {
            localConstraints[axis] = constraint
          }
        }
      }

      toLocalConstraintsIfDependencyMissing(apiConstraints, localConstraints, caps, axisMap)
      
      if (Object.keys(apiConstraints).length === 0) {
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
      
      let url = api.getSubsetUrl(apiConstraints)
      return wrapOptions.loader(url).then(subset => {
        // apply remaining subset constraints
        if (Object.keys(localConstraints).length > 0) {
          // again, we DON'T wrap the locally subsetted coverage again, see above
          return subset.subsetByIndex(localConstraints)
        } else {
          return wrap(subset, wrapOptions)
        }
      })
    })
  }
}

function wrappedSubsetByValue (coverage, wrappedCoverage, api, wrapOptions) {
  return constraints => {
    return coverage.loadDomain().then(domain => {
      constraints = cleanedConstraints(constraints)
      
      if (!requiresSubsetting(domain, constraints)) {
        return wrappedCoverage
      }
      
      let caps = api.capabilities.subset      
      let axisMap = getAxisConcepts(domain)
      
      /* If the API does not support target-based subsetting, then this can be emulated
       * via intersection-based subsetting by inspecting the domain locally first
       * and then subsetting with equal start/stop with the identified domain value.
       * The same is done for exact match subsetting.
       * 
       * FIXME this approach will return invalid results (two instead of one axis step)
       * if the axis has bounds and they are aligned such that a bound start or end
       * is identical to the axis value and the neighboring bounds share their start/end.
       * This is common in WaterML. To account for that, this scenario could be explicitly checked for.
       * A safe start/stop would then be a newly calculated axis value which is in the middle
       * of the bounds.
       */
        
      // we split the subsetting constraints into API-compatible and local ones
      let apiConstraints = {} // API concept -> spec
      let localConstraints = {} // axis name -> spec
      for (let axis of Object.keys(constraints)) {
        let useApi = false
        let constraint = constraints[axis]
        
        let isTimeString = axisMap[axis] === 'time'
        
        if (!caps[axisMap[axis]]) {
          // leave useApi = false
        } else if (typeof constraint !== 'object') {
          if (caps[axisMap[axis]].identity) {
            useApi = true
          } else if (caps[axisMap[axis]].start && caps[axisMap[axis]].stop) {
            // emulate identity match via start/stop if we find a matching axis value
            let idx = getClosestIndex(domain, axis, constraint.target, isTimeString)
            let val = domain.axes.get(axis).values[idx]
            if (isTimeString) {
              if (new Date(val).getTime() === new Date(constraint).getTime()) {
                constraint = {start: constraint, stop: constraint}
                useApi = true
              }
            } else if (val === constraint) {
              constraint = {start: constraint, stop: constraint}
              useApi = true
            }
          }
        } else if ('target' in constraint) {
          if (caps[axisMap[axis]].target) {
            useApi = true
          } else if (caps[axisMap[axis]].start && caps[axisMap[axis]].stop) {
            // emulate target via start/stop
            let idx = getClosestIndex(domain, axis, constraint.target, isTimeString)
            let val = domain.axes.get(axis).values[idx]
            constraint = {start: val, stop: val}
            useApi = true
          }
        } else {
          // start / stop
          useApi = caps[axisMap[axis]].start && caps[axisMap[axis]].stop
        }
                     
        if (useApi) {
          apiConstraints[axisMap[axis]] = constraint
        } else {
          localConstraints[axis] = constraint
        }
      }
      
      toLocalConstraintsIfDependencyMissing(apiConstraints, localConstraints, caps, axisMap)
      
      if (Object.keys(apiConstraints).length === 0) {
        // again, we DON'T wrap the locally subsetted coverage again, see above
        return coverage.subsetByValue(constraints)
      }
      
      let url = api.getSubsetUrl(apiConstraints)        
      return wrapOptions.loader(url).then(subset => {
        // apply remaining subset constraints
        if (Object.keys(localConstraints).length > 0) {
          // again, we DON'T wrap the locally subsetted coverage again, see above
          return subset.subsetByValue(localConstraints)
        } else {
          return wrap(subset, wrapOptions)
        }
      })
    })
  }
}

/**
 * Returns an object that maps axis keys to API concept names.
 */
function getAxisConcepts (domain) {
  // TODO don't hard-code, but derive from referencing info of domain
  return {
    x: 'x',
    y: 'y',
    z: 'vertical',
    t: 'time'
  }
}

/**
 *  Check if all API dependencies between concepts are met.
 *  This is mainly for the bounding box case which needs both x and y.
 *  If a dependency is missing, then the constraint is moved to the
 *  locally applied ones.
 */
function toLocalConstraintsIfDependencyMissing (apiConstraints, localConstraints, capabilities, axisConcepts) {
  for (let concept of Object.keys(apiConstraints)) {
    let depends = capabilities[concept].dependency
    if (depends && depends.some(concept_ => !apiConstraints.has(concept_))) {
      let axis = Object.keys(axisConcepts).filter(axis => axisConcepts[axis] === concept)[0]
      localConstraints[axis] = apiConstraints[concept]
      delete apiConstraints[concept]
    }
  }
}

function getClosestIndex (domain, axis, val, isTimeString) {
  let vals = domain.axes.get(axis).values
  if (isTimeString) {
    // convert to unix timestamps as we need numbers
    val = new Date(val).getTime()
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

function cleanedConstraints (constraints) {
  let cleanConstraints = shallowcopy(constraints)
  for (let key of Object.keys(constraints)) {
    if (constraints[key] === undefined || constraints[key] === null) {
      delete cleanConstraints[key]
    }
  }
  return cleanConstraints
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
