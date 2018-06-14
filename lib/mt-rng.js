const MersenneTwister = require('mersenne-twister');
const rng = new MersenneTwister();

let random = rng.random.bind(rng);

module.exports = random;
