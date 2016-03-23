# Coverage REST Client

An experimental library that wraps [Coverage or Coverage Collection objects](https://github.com/Reading-eScience-Centre/coverage-jsapi)
and runs operations like subsetting through a REST API that follows the ["Coverage Data REST API Core Specification"](https://github.com/Reading-eScience-Centre/coverage-restapi) instead of loading the complete data and doing it locally.

## Example using covjson-reader

We use the [covjson-reader](https://github.com/Reading-eScience-Centre/covjson-reader) library
to load a [CoverageJSON](https://github.com/neothemachine/coveragejson) document which then is wrapped with the coverage-rest-client library in order to support pagination and run operations like subsetting or collection filtering server-side.

```js
var url = 'http://example.com/temperature.covjson'
CovJSON.read(url).then(function (cov) {
  return CoverageREST.wrap(cov, {loader: CovJSON.read})
}).then(function (cov) {
  // work with REST-enabled coverage data object
})
```

## How it works

The magic is in the currently experimental `.ld` (as in linked data) property of a coverage data object. This property is a JSON-LD document and can contain API metadata which this library then may understand. Currently it has support for most of the techniques described in the ["Coverage Data REST API Core Specification"](https://github.com/Reading-eScience-Centre/coverage-restapi).

For the interested ones: All HTTP Link headers (which may be used for pagination) are generically transformed and copied into the JSON-LD object by the [covjson-reader](https://github.com/Reading-eScience-Centre/covjson-reader) library. The transformation is simply to prefix registered relations with `http://www.iana.org/assignments/relation/` and treat the Link header as an RDF triple. By doing this, there is a uniform way to handle API control data both in HTTP headers and embedded in the coverage data document itself.

Note that this library currently supports arbitrary JSON-LD and uses the [jsonld.js](https://github.com/digitalbazaar/jsonld.js) parser which is not that lightweight in terms of file size. It may be the case that in the future a JSON-LD profile for such coverage-related REST API control data is created which would force a specific JSON-LD structure and allow easier processing without a full JSON-LD parser.

