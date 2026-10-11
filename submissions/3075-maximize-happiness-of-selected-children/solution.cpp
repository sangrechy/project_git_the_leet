class Solution {
public:
    long long maximumHappinessSum(vector<int>& happiness, int k) {
        sort(happiness.rbegin(),happiness.rend());
        long long int t=0;
        for (int i=0;i<k;i++){
            long long x=(happiness[i])-i;
            if (x>0){
                t=x+t;
            }
            
        }
        return t;
        
    }
};