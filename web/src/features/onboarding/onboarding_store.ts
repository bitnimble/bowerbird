import { observable } from 'mobx';

export class OnboardingStore {
  @observable accessor pipelinesReady = false;
  @observable accessor pipelinesCompiled = 0;
  @observable accessor pipelinesToCompile = 0;
}
