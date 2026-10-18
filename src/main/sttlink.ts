/**
 * The pill page streams audio to the recognizer over a MessagePort that main hands to both. A port posted before
 * the page has loaded its listener is silently lost, so the link is made only once the recognizer is running and
 * the pill has said it is ready, and again whenever either side is replaced.
 */
export class SttLink<W> {
  private worker: W | undefined;
  private ready = false;

  constructor(private readonly connect: (worker: W) => void) {}

  setWorker(worker: W | undefined): void {
    this.worker = worker;
    this.link();
  }

  pillReady(): void {
    this.ready = true;
    this.link();
  }

  pillGone(): void {
    this.ready = false;
  }

  private link(): void {
    if (this.worker !== undefined && this.ready) this.connect(this.worker);
  }
}
