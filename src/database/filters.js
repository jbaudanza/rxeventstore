export function toSQL(filters) {
  const conditions = [];
  const values = [];

  Object.keys(filters).forEach(function(key) {
    let value = filters[key];
    let operator = '=';

    if (typeof value === 'object') {
      const keys = Object.keys(value);
      if (keys.length === 1) {
        switch (keys[0]) {
          case '$gt':
            value = value[keys[0]];
            operator = '>';
            break;
          case '$lt':
            value = value[keys[0]];
            operator = '<';
            break;
          case '$eq':
            value = value[keys[0]];
            operator = '=';
            break;
        }
      }
    }

    let placeholder;
    if (Array.isArray(value)) {
      operator = '= ANY';
      placeholder = `($${conditions.length + 1})`;
    } else {
      placeholder = `$${conditions.length + 1}`;
    }

    conditions.push(`${key} ${operator} ${placeholder}`);
    values.push(value);
  });

  return [conditions.join(' AND '), values];
}


// This is from https://github.com/joliss/js-string-escape
function escapeJsStringLiteral(string) {
  return ('' + string).replace(/["'\\\n\r\u2028\u2029]/g, function (character) {
    // Escape all characters not included in SingleStringCharacters and
    // DoubleStringCharacters on
    // http://www.ecma-international.org/ecma-262/5.1/#sec-7.8.4
    switch (character) {
      case '"':
      case "'":
      case '\\':
        return '\\' + character
      // Four possible LineTerminator characters need to be escaped:
      case '\n':
        return '\\n'
      case '\r':
        return '\\r'
      case '\u2028':
        return '\\u2028'
      case '\u2029':
        return '\\u2029'
    }
  });
}

function escapeJsLiteral(literal) {
  if (typeof literal === 'string') {
    return '"' + escapeJsStringLiteral(literal) + '"';
  } else {
    return String(literal);
  }
}

export function toFunction(filters) {
  const filterKeys = Object.keys(filters);
  let conditions;

  if (filterKeys.length === 0) {
    conditions = ['true'];
  } else {
    conditions = filterKeys.map(function(attributeName) {
      let value = filters[attributeName];
      let operator = '===';

      if (typeof value === 'object') {
        const keys = Object.keys(value);
        if (keys.length === 1) {
          switch (keys[0]) {
            case '$gt':
              value = value[keys[0]];
              operator = '>';
              break;
            case '$lt':
              value = value[keys[0]];
              operator = '<';
              break;
            case '$eq':
              value = value[keys[0]];
              operator = '===';
              break;
          }
        }
      }

      const lhs = 'o["' + escapeJsStringLiteral(attributeName) + '"]';

      if (Array.isArray(value)) {
        return '(' + value.map(function(option) {
          return lhs + '===' + escapeJsLiteral(option);
        }).join('||') + ')';
      } else {
        return lhs + operator + escapeJsLiteral(value);
      }
    });
  }

  const js = '(function(o){return '
    + conditions.join('&&')
    + ';})';

  return eval(js);
}
