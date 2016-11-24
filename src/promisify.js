// This instruments an object methods with new methods that return promises
// instead of callbacks.
export default function promisify(object, ...methods) {
  const properties = {};

  methods.forEach(function(method) {
    const value = function() {
      const args = Array.prototype.slice.call(arguments);
      return new Promise(function(resolve, reject) {
        object[method].apply(object, args.concat(function(err, result) {
          if (err) reject(err);
          else resolve(result);
        }));
      });
    };
    properties[method] = {value: value};
  });

  return Object.create(object, properties);
}
