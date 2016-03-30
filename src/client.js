import * as API from './api.js'
import * as arrays from './arrays.js'
import {shallowcopy, mergeInto} from './util.js'
import {isISODateAxis, isLongitudeAxis, getLongitudeWrapper} from './referencing.js'

// Note: We currently can't handle Hydra data in non-default graphs due to lack of support in JSON-LD framing.

/**
 * Wraps a Coverage or Coverage Collection object and executes certain functions
 * via a remote API, in particular subsetting.
 * 
 * @param {object} data The Coverage API object to wrap.
 * @param {object} options Options which control the behaviour of the wrapper.
 * @param {function} options.loader 
 *   The function to use for loading coverage data from a URL.
 *   It is called as loader(url, options) where options corresponds to the
 *   options parameter of Coverage.subsetBy* and CoverageCollectionQuery.execute.
 *   It must return a Promise succeeding with a Coverage Data API object.
 *   
 * @returns {object} The wrapped Coverage Data API object.
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

function wrapCollection (collection, wrapOptions) {
  // TODO wrap each individual coverage as well!
  return API.discover(collection).then(api => {
    let newcoll = shallowcopy(collection)
    newcoll.query = () => {
      let query = collection.query()
      return new QueryProxy(query, newcoll, api, wrapOptions)
    }
    if (api.isPaged) {
      let load = wrapOptions.loader
      let wrapPageLink = url => {
        if (!url) return
        return {
          load: (options) => load(url, options).then(coll => wrap(coll, wrapOptions))
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
  constructor (query, collection, api, wrapOptions) {
    this._query = query
    this._collection = collection
    this._api = api
    this._wrapOptions = wrapOptions
    
    this._filter = {}
    this._subset = {}
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
    
  execute (options) {
    let domainTemplate = this._collection.domainTemplate
    if (domainTemplate) {
      return this._doExecute(domainTemplate)
    } else {
      // inspect domain of first coverage and assume uniform collection
      if (this._collection.coverages.length > 0) {
        return this._collection.coverages[0].loadDomain().then(domain => this._doExecute(options, domain))
      } else {
        return this._query.execute(options)
      }
    }
  }
  
  _doExecute (options, domainTemplate) {
    let load = this._wrapOptions.loader
    
    let filterCaps = this._api.capabilities.filter
    let subsetCaps = this._api.capabilities.subset
    let axisMap = getAxisConcepts(domainTemplate)
    
    // split constraints into API and locally applied ones
    let apiConstraints = {
      filter: {},
      subset: {}
    }

    let localFilterConstraints = {} // axis name -> spec
    let localSubsetConstraints = {} // axis name -> spec
    
    // filtering
    for (let axis of Object.keys(this._filter)) {
      let constraint = this._filter[axis]      
      let cap = filterCaps[axisMap[axis]]
      if (cap && cap.start && cap.stop) {
        apiConstraints.filter[axisMap[axis]] = constraint
      } else {
        localFilterConstraints[axis] = constraint
      }
    }

    // subsetting
    for (let axis of Object.keys(this._subset)) {
      let constraint = this._subset[axis]
      let cap = subsetCaps[axisMap[axis]]
      let useApi = false
      
      if (!cap) {
        // leave useApi = false
      } else if (typeof constraint !== 'object' && cap.identity) {
        useApi = true
      } else if ('target' in constraint && cap.target) {
        useApi = true
      } else if ('start' in constraint && 'stop' in constraint && cap.start && cap.stop) {
        useApi = true
      }
      
      if (useApi) {
        apiConstraints.subset[axisMap[axis]] = constraint
      } else {
        localSubsetConstraints[axis] = constraint
      }
    }
    
    toLocalConstraintsIfDependencyMissing(apiConstraints.filter, localFilterConstraints, filterCaps, axisMap)
    toLocalConstraintsIfDependencyMissing(apiConstraints.subset, localSubsetConstraints, subsetCaps, axisMap)
    
    if (Object.keys(apiConstraints.filter).length === 0 && 
        Object.keys(apiConstraints.subset).length === 0) {
      return this._query.execute(options)
    }
    
    let url = this._api.getUrl(apiConstraints)        
    return load(url, options).then(resultCollection => {
      // apply remaining query parts
      if (Object.keys(localSubsetConstraints).length > 0 || Object.keys(localFilterConstraints).length > 0) {
        // the locally queried collection is NOT wrapped! see comment for coverage subsetting below
        return resultCollection.query()
          .filter(localFilterConstraints)
          .subset(localSubsetConstraints)
          .execute()
      } else {
        return wrap(resultCollection, this._wrapOptions)
      }
    })
  }
}

function wrapCoverage (coverage, wrapOptions) {
  return API.discover(coverage).then(api => {
    let wrappedCoverage = shallowcopy(coverage)
    wrappedCoverage.subsetByIndex = wrappedSubsetByIndex(coverage, wrappedCoverage, api, wrapOptions)
    wrappedCoverage.subsetByValue = wrappedSubsetByValue(coverage, wrappedCoverage, api, wrapOptions)
    return wrappedCoverage
  })
}

function wrappedSubsetByIndex (coverage, wrappedCoverage, api, wrapOptions) {
  return (constraints, options = {}) => {
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
      let apiConstraints = {
        subset: {} // API concept -> spec
      }
      let localSubsetConstraints = {} // axis name -> spec
      
      if (caps.index) {
        apiConstraints.subset.index = constraints
      } else {
        // try to emulate some constraints
        for (let axis of Object.keys(constraints)) {
          let useApi = false
          let constraint = constraints[axis]
          let cap = caps[axisMap[axis]]
          
          if (!cap) {
            // leave useApi = false
          } else if (typeof constraint !== 'object') {
            if (cap.start && cap.stop) {
              // emulate identity match via start/stop
              let val = domain.axes.get(axis).values[constraint]
              constraint = {start: val, stop: val}
              useApi = true
            }
          } else if (!constraint.step) {
            // start / stop
            if (cap.start && cap.stop) {
              let start = domain.axes.get(axis).values[constraint.start]
              let stop = domain.axes.get(axis).values[constraint.stop]
              constraint = {start, stop}
              useApi = true
            }
          }
                       
          if (useApi) {
            apiConstraints.subset[axisMap[axis]] = constraint
          } else {
            localSubsetConstraints[axis] = constraint
          }
        }
      }

      toLocalConstraintsIfDependencyMissing(apiConstraints.subset, localSubsetConstraints, caps, axisMap)
      
      if (Object.keys(apiConstraints.subset).length === 0) {
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
        return coverage.subsetByIndex(constraints, options)
      }
      
      let url = api.getUrl(apiConstraints)
      return wrapOptions.loader(url, options).then(subset => {
        // apply remaining subset constraints
        if (Object.keys(localSubsetConstraints).length > 0) {
          // again, we DON'T wrap the locally subsetted coverage again, see above
          return subset.subsetByIndex(localSubsetConstraints, options)
        } else {
          return wrap(subset, wrapOptions)
        }
      })
    })
  }
}

function wrappedSubsetByValue (coverage, wrappedCoverage, api, wrapOptions) {
  return (constraints, options = {}) => {
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
      
      // TODO if API axis-value-subsetting is not supported, try to emulate with API axis-index-subsetting
        
      // we split the subsetting constraints into API-compatible and local ones
      let apiConstraints = {
        subset: {} // API concept -> spec
      }
      let localSubsetConstraints = {} // axis name -> spec
      
      for (let axis of Object.keys(constraints)) {
        let useApi = false
        let constraint = constraints[axis]
        let cap = caps[axisMap[axis]]
        let isTimeString = isISODateAxis(domain, axis)
        
        if (!cap) {
          // leave useApi = false
        } else if (typeof constraint !== 'object') {
          if (cap.identity) {
            useApi = true
          } else if (cap.start && cap.stop) {
            // emulate identity match via start/stop if we find a matching axis value
            let idx = getClosestIndex(domain, axis, constraint.target)
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
          if (cap.target) {
            useApi = true
          } else if (cap.start && cap.stop) {
            // emulate target via start/stop
            let [vals, target] = prepareForAxisArraySearch(domain, axis, constraint.target)
            // FIXME handle explicit bounds
            let [minBound,maxBound] = getAxisExtent(vals)
            // if the target is outside the axis extent then the API can't be used (as there is no intersection then)
            if (minBound <= target && target <= maxBound) {
              let idx = getClosestIndex(domain, axis, constraint.target)
              let val = domain.axes.get(axis).values[idx]
              constraint = {start: val, stop: val}
              useApi = true
            }
          }
        } else {
          // start / stop
          useApi = cap.start && cap.stop
          
          if (useApi) {
            // FIXME handle explicit bounds
            
            // snap start/stop to axis values to increase the chance of using a cached request
            let [vals, start, stop] = prepareForAxisArraySearch(domain, axis, constraint.start, constraint.stop)
            let [minBound,maxBound] = getAxisExtent(vals)
            if (stop < minBound || start > maxBound) {
              // if both start and stop are outside the axis extent, then snapping would be wrong (has to be an error)
              throw new Error('start or stop must be inside the axis extent')
            } else {
              let idxStart = getClosestIndexArr(vals, start)
              let idxStop = getClosestIndexArr(vals, stop)
              let axisVals = domain.axes.get(axis).values
              constraint = {start: axisVals[idxStart], stop: axisVals[idxStop]}
            }
          }
        }
                     
        if (useApi) {
          apiConstraints.subset[axisMap[axis]] = constraint
        } else {
          localSubsetConstraints[axis] = constraint
        }
      }
      
      toLocalConstraintsIfDependencyMissing(apiConstraints.subset, localSubsetConstraints, caps, axisMap)
      
      if (Object.keys(apiConstraints.subset).length === 0) {
        // again, we DON'T wrap the locally subsetted coverage again, see above
        return coverage.subsetByValue(constraints, options)
      }
      
      let url = api.getUrl(apiConstraints)        
      return wrapOptions.loader(url, options).then(subset => {
        // apply remaining subset constraints
        if (Object.keys(localSubsetConstraints).length > 0) {
          // again, we DON'T wrap the locally subsetted coverage again, see above
          return subset.subsetByValue(localSubsetConstraints, options)
        } else {
          return wrap(subset, wrapOptions)
        }
      })
    })
  }
}

/**
 * Returns an object that maps axis keys to API concept names by
 * interpreting domain referencing info.
 * An axis with unknown concept is mapped to undefined.
 */
function getAxisConcepts (domain) {
  let axisConcepts = {}
  let referencing = domain.referencing
  for (let axis of domain.axes.keys()) {
    let concept = undefined
    
    let ref = referencing.filter(ref => ref.components.indexOf(axis) !== -1)
    if (ref.length === 1) {
      let {components, system} = ref[0]
      
      if (system.type === 'TemporalRS') {
        // The assumption is that if the API offers filtering/subsetting by time,
        // then this happens in the same concrete temporal system (calendar etc.).
        // Also, it is assumed that there is only one time axis.
        // TODO how to locate the "main" time axis if there are multiple?
        //      see https://github.com/Reading-eScience-Centre/coveragejson/issues/45
        concept = 'time'
      } else if (system.type === 'VerticalCRS') {
        concept = 'vertical'
      } else if (system.type === 'GeodeticCRS' || system.type === 'ProjectedCRS') {
        // a geodetic crs can be x,y or x,y,z
        // a projected crs is x,y
        let idx = components.indexOf(axis)
        if (idx === 0) {
          concept = 'x'
        } else if (idx === 1) {
          concept = 'y'
        } else if (idx === 2) {
          concept = 'vertical'
        }
      }
    }
    
    axisConcepts[axis] = concept
  }  
  return axisConcepts
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
    if (depends && depends.some(concept_ => !apiConstraints[concept_])) {
      let axis = Object.keys(axisConcepts).filter(axis => axisConcepts[axis] === concept)[0]
      localConstraints[axis] = apiConstraints[concept]
      delete apiConstraints[concept]
    }
  }
}

function getAxisExtent (vals) {
  // TODO handle explicit axis bounds (currently assumes a regular axis)
  let [min, max] = [vals[0], vals[vals.length-1]]
  if (min > max) {
    [min, max] = [max, min]
  }
  if (vals.length > 1) {
    // calculate cell size and extend by half a cell size on each end
    let halfSize = Math.abs(vals[0] - vals[1]) / 2;
    [min, max] = [min - halfSize, max + halfSize]
  }
  return [min, max]
}

function getClosestIndex (domain, axis, val) {
  let [axisVals, searchVal] = prepareForAxisArraySearch(domain, axis, val)
  return getClosestIndexArr(axisVals, searchVal) 
}

function getClosestIndexArr (vals, val) {
  let [lo,hi] = arrays.indicesOfNearest(vals, val)
  let idx = Math.abs(val - vals[lo]) <= Math.abs(val - vals[hi]) ? lo : hi
  return idx
}

function prepareForAxisArraySearch (domain, axis, ...searchVal) {
  let axisVals = domain.axes.get(axis).values
  searchVal = [...searchVal] // to array
  if (isISODateAxis(domain, axis)) {
    // convert to unix timestamps as we need numbers
    let toUnix = v => new Date(v).getTime()
    searchVal = searchVal.map(toUnix)
    axisVals = axisVals.map(toUnix)
  } else if (isLongitudeAxis(domain, axis)) {
    let lonWrapper = getLongitudeWrapper(domain, axis)
    searchVal = searchVal.map(lonWrapper)
  }
  return [axisVals, ...searchVal]
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

