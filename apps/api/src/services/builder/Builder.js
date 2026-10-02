/**
 * Abstract Builder Interface
 * Swappable interface for image building strategies.
 */
class Builder {
  /**
   * Builds a container image for the specified release.
   * @param {Object} release - The Release document or record.
   * @param {Object} options - Build execution options (sourcePath, registryHost, timeout, onLog).
   * @returns {Promise<{ image: string, digest: string }>}
   */
  async build(release, options = {}) {
    throw new Error('Method build() must be implemented by subclass.');
  }
}

module.exports = Builder;
